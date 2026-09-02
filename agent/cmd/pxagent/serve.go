package main

import (
	"context"
	"flag"
	"fmt"
	"time"

	"github.com/pxhost/agent/internal/api"
	"github.com/pxhost/agent/internal/auth"
	"github.com/pxhost/agent/internal/config"
	"github.com/pxhost/agent/internal/dockerx"
	"github.com/pxhost/agent/internal/fsx"
	"github.com/pxhost/agent/internal/panel"
	"github.com/pxhost/agent/internal/spec"
	"github.com/pxhost/agent/internal/srv"
)

const agentVersion = "v0.4.0-dev" // bumped alongside milestones; reported on every heartbeat

// serveFlags is a repeatable -server flag: `pxagent serve --node n.json
// --server a.json --server b.json ...`.
type serveFlags []string

func (f *serveFlags) String() string     { return fmt.Sprint([]string(*f)) }
func (f *serveFlags) Set(v string) error { *f = append(*f, v); return nil }

// runServeCmd starts the agent's HTTP + WebSocket control surface (M2).
// It loads a node profile and zero or more server definitions, adopts any
// already-running containers for those servers (a minimal preview of the
// full boot reconciliation that lands in M3), optionally auto-starts them,
// then serves until interrupted.
func runServeCmd(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	nodePath := fs.String("node", "", "path to node.json")
	autostart := fs.Bool("autostart", false, "start every registered server immediately")
	var serverPaths serveFlags
	fs.Var(&serverPaths, "server", "path to a server.json (repeatable)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *nodePath == "" {
		return fmt.Errorf("--node is required")
	}

	ctx, cancel := signalContext()
	defer cancel()

	node, nf, err := config.LoadNode(*nodePath)
	if err != nil {
		return err
	}
	if nf.NodeUUID == "" {
		return fmt.Errorf("node.json: node_uuid is required for serve")
	}
	if nf.NodeToken == "" {
		return fmt.Errorf("node.json: node_token is required for serve")
	}
	if nf.PanelPublicKeyPath == "" {
		return fmt.Errorf("node.json: panel_public_key_path is required for serve")
	}
	listenAddr := nf.ListenAddr
	if listenAddr == "" {
		listenAddr = ":8443"
	}

	pubKey, err := config.LoadPanelPublicKey(nf.PanelPublicKeyPath)
	if err != nil {
		return err
	}
	verifier := auth.NewTokenVerifier(pubKey, nf.NodeUUID, 10*time.Second)

	dc, err := dockerx.New(ctx)
	if err != nil {
		return err
	}
	defer dc.Close()

	if err := dc.EnsureNetwork(ctx, node.NetworkName, nf.NetworkSubnet, nf.NetworkGateway); err != nil {
		return err
	}

	manager := srv.NewManager()
	for _, p := range serverPaths {
		if err := loadAndAdopt(ctx, manager, dc, node, p, *autostart); err != nil {
			return fmt.Errorf("loading %s: %w", p, err)
		}
	}

	// Shared by the API's incoming-request check, the heartbeat loop, and
	// the rotation loop below — see internal/api/tokenstore.go.
	tokenStore := api.NewTokenStore(nf.NodeToken)

	apiServer := api.New(api.Config{
		Manager:          manager,
		Docker:           dc,
		Verifier:         verifier,
		Node:             node,
		NodeUUID:         nf.NodeUUID,
		TokenStore:       tokenStore,
		PanelURL:         nf.PanelURL,
		BgCtx:            ctx,
		WSOriginPatterns: nf.WSAllowedOrigins,
	})

	errCh := make(chan error, 1)
	go func() { errCh <- apiServer.ListenAndServe(listenAddr) }()

	fmt.Printf("pxagent serving on %s (%d server(s) registered)\n", listenAddr, len(serverPaths))

	if nf.PanelURL != "" {
		go runHeartbeatLoop(ctx, nf, tokenStore, dc)
		if nf.TokenRotationIntervalHours > 0 {
			go runTokenRotationLoop(ctx, *nodePath, nf, tokenStore)
		}
		go runJWKSRefreshLoop(ctx, nf, verifier)
	} else {
		fmt.Println("no panel_url configured — running standalone, not reporting heartbeats")
	}

	select {
	case <-ctx.Done():
		fmt.Println("shutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return apiServer.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}

// loadAndAdopt registers one server with the manager. If a matching
// container already exists (e.g. created by an earlier `pxagent server
// create`), its id/state are adopted rather than erroring — this is a
// deliberately small preview of the full boot-reconciliation sweep that
// architecture doc 4.1 describes for M3, scoped to what M2's demo needs.
// Otherwise a fresh container is pulled and created.
func loadAndAdopt(ctx context.Context, manager *srv.Manager, dc *dockerx.Client, node spec.Node, serverPath string, autostart bool) error {
	sv, err := config.LoadServer(serverPath)
	if err != nil {
		return err
	}

	s, err := manager.Register(sv, node)
	if err != nil {
		return err
	}

	id, err := findContainerID(ctx, dc, sv.UUID)
	switch {
	case err == nil:
		// A container from an earlier CLI-driven run already exists;
		// adopt it rather than failing on "name already in use".
		s.ContainerID = id
		fmt.Printf("adopted existing container %s for server %s\n", id, sv.UUID)
	default:
		digest := ""
		if idx := indexByte(sv.Image, '@'); idx != -1 {
			digest = sv.Image[idx+1:]
		}
		if err := dc.PullPinned(ctx, sv.Image, digest); err != nil {
			return err
		}
		if err := s.Create(ctx, dc); err != nil {
			return err
		}
		fmt.Printf("created container %s for server %s\n", s.ContainerID, sv.UUID)
	}

	if autostart && s.State != srv.StateRunning {
		if err := s.Start(ctx, dc); err != nil {
			return fmt.Errorf("autostart: %w", err)
		}
		fmt.Printf("started server %s\n", sv.UUID)
	}
	return nil
}

// runHeartbeatLoop reports liveness to the panel on a fixed interval for
// as long as the process runs (architecture doc 4.2/7 — this is what
// flips a node from "unknown"/"offline" to "online" in the panel's UI,
// and keeps it there). Uses the node token obtained by a prior `pxagent
// bootstrap` run; a heartbeat failure is logged and retried on the next
// tick, never fatal to the agent process — a panel outage must not take
// down a node's already-running game servers.
func runHeartbeatLoop(ctx context.Context, nf config.NodeFile, tokenStore *api.TokenStore, dc *dockerx.Client) {
	interval := time.Duration(nf.HeartbeatIntervalSeconds) * time.Second
	if interval <= 0 {
		interval = 15 * time.Second
	}
	client := panel.New(nf.PanelURL)
	started := time.Now()

	// dockerx.Info (host mem/cpu/os/kernel/container-count) changes slowly
	// and costs a real daemon round trip, so it's cached across ticks —
	// disk free space is refreshed every tick instead, since it's the
	// number that actually moves and a syscall.Statfs call is cheap
	// (capacity plan Fase 7).
	const infoCacheTTL = 5 * time.Minute
	var cachedInfo dockerx.SystemInfo
	var cachedInfoAt time.Time

	send := func() {
		dockerVersion := ""
		if v, err := dc.Version(ctx); err == nil {
			dockerVersion = v
		}

		req := panel.HeartbeatRequest{
			AgentVersion:  agentVersion,
			DockerVersion: dockerVersion,
			UptimeSeconds: int64(time.Since(started).Seconds()),
		}

		// Every telemetry source below is independently best-effort — a
		// failure just leaves that tick's fields at zero (omitted from
		// the JSON body via `omitempty`), never blocks or fails the
		// heartbeat itself.
		if cachedInfoAt.IsZero() || time.Since(cachedInfoAt) > infoCacheTTL {
			if info, err := dc.Info(ctx); err == nil {
				cachedInfo = info
				cachedInfoAt = time.Now()
			}
		}
		if !cachedInfoAt.IsZero() {
			req.ReportedMemoryTotalMb = cachedInfo.MemTotalBytes / (1024 * 1024)
			req.ReportedCPUCount = cachedInfo.NCPU
			req.ReportedOS = cachedInfo.OperatingSystem
			req.ReportedKernel = cachedInfo.KernelVersion
			req.ReportedContainersRunning = cachedInfo.ContainersRunning
		}

		if total, free, err := fsx.DiskUsage(nf.DataDir); err == nil {
			req.ReportedDiskTotalMb = int64(total / (1024 * 1024))
			req.ReportedDiskFreeMb = int64(free / (1024 * 1024))
		}

		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		_, err := client.Heartbeat(reqCtx, tokenStore.Get(), req)
		if err != nil {
			fmt.Printf("heartbeat failed (will retry in %s): %v\n", interval, err)
		}
	}

	send() // first heartbeat immediately, don't wait a full interval to go "online"
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			send()
		}
	}
}

// runTokenRotationLoop periodically trades the node's current token for a
// fresh one (architecture doc roadmap M13: "token rotation") — the same
// call `pxagent rotate-token` makes once, just on a schedule for as long
// as `serve` runs. A failure is logged and retried on the next tick,
// never fatal: the OLD token keeps working (nothing revokes it until a
// rotation actually succeeds), so a transient panel outage just means
// rotation is late, not that the node goes deaf.
//
// nodePath is re-loaded-and-saved through, not just held in memory: a
// node.json that still has the token from six rotations ago is useless
// after a process restart, so every successful rotation is durable
// immediately, not batched or deferred.
func runTokenRotationLoop(ctx context.Context, nodePath string, nf config.NodeFile, tokenStore *api.TokenStore) {
	interval := time.Duration(nf.TokenRotationIntervalHours) * time.Hour
	client := panel.New(nf.PanelURL)

	rotate := func() {
		reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		resp, err := client.RotateToken(reqCtx, tokenStore.Get())
		if err != nil {
			fmt.Printf("token rotation failed (will retry in %s): %v\n", interval, err)
			return
		}
		tokenStore.Set(resp.NodeToken)
		nf.NodeToken = resp.NodeToken
		if err := config.SaveNode(nodePath, nf); err != nil {
			// The in-memory token IS the new one at this point (both
			// directions already agree) — only the on-disk copy is
			// stale, which matters for the NEXT process restart, not
			// this one. Logged loudly since an operator should fix the
			// underlying disk/permissions issue before that happens.
			fmt.Printf("token rotation succeeded but failed to persist to %s: %v\n", nodePath, err)
			return
		}
		fmt.Println("rotated node token")
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rotate()
		}
	}
}

// jwksRefreshInterval matches architecture doc 3.4's stated cadence
// ("caches and refreshes every 5 minutes") — frequent enough that a
// rotation's new key reaches every node well within any reasonable
// "current + retiring" overlap window, without hammering the panel.
const jwksRefreshInterval = 5 * time.Minute

// runJWKSRefreshLoop keeps verifier's trusted key set in sync with the
// panel's JWKS (architecture doc roadmap M13). A fetch failure is
// logged and simply retried next tick — the verifier keeps trusting
// whatever it already has (which includes the static
// panel_public_key_path fallback until the very first successful
// fetch), so a panel outage degrades to "can't learn about a NEW
// rotation," never "consoles stop authenticating."
func runJWKSRefreshLoop(ctx context.Context, nf config.NodeFile, verifier *auth.TokenVerifier) {
	client := panel.New(nf.PanelURL)

	refresh := func() {
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		keys, err := client.FetchJWKS(reqCtx)
		if err != nil {
			fmt.Printf("jwks refresh failed (will retry in %s): %v\n", jwksRefreshInterval, err)
			return
		}
		verifier.SetKeys(keys)
	}

	refresh() // fetch immediately so a rotated key is trusted without waiting a full interval
	ticker := time.NewTicker(jwksRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}
