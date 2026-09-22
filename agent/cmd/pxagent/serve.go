package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/gxhost/agent/internal/api"
	"github.com/gxhost/agent/internal/auth"
	"github.com/gxhost/agent/internal/config"
	"github.com/gxhost/agent/internal/dockerx"
	"github.com/gxhost/agent/internal/fsx"
	"github.com/gxhost/agent/internal/hostinfo"
	"github.com/gxhost/agent/internal/panel"
	"github.com/gxhost/agent/internal/preflight"
	"github.com/gxhost/agent/internal/spec"
	"github.com/gxhost/agent/internal/srv"
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

	// Before anything else: a node that cannot chown cannot install a
	// server, accept a file upload, or receive a transfer. Starting
	// anyway means heartbeating as healthy and having the panel schedule
	// work onto a node that will fail all of it — see
	// preflight.CheckCapabilities for the live incident.
	if err := preflight.CheckCapabilities(); err != nil {
		return err
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

	// Best-effort, and deliberately BEFORE anything else touches
	// node.DataDir: a modpack install / backup restore's own delayed
	// cleanup goroutine (1h) does not survive an agent restart, so a
	// server that is never touched again after such an operation leaks
	// its swap-leftover directory forever. See srv.SweepStaleOldDirs'
	// own doc comment for the safety rule that keeps this from ever
	// touching an in-progress or incomplete swap.
	srv.SweepStaleOldDirs(node.DataDir, slog.Default())

	manager := srv.NewManager()
	adopted, err := reconcileManagedContainers(ctx, manager, dc, node)
	if err != nil {
		return fmt.Errorf("reconciling managed containers: %w", err)
	}
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

	fmt.Printf("pxagent serving on %s (%d server(s) registered)\n", listenAddr, adopted+len(serverPaths))

	if nf.PanelURL != "" {
		go runHeartbeatLoop(ctx, nf, tokenStore, dc, manager)
		if nf.TokenRotationIntervalHours > 0 {
			go runTokenRotationLoop(ctx, *nodePath, nf, tokenStore)
		}
		go runJWKSRefreshLoop(ctx, nf, verifier)
		go runReconcileLoop(ctx, manager, nf, tokenStore, dc)
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

// reconcileManagedContainers rebuilds the volatile manager from Docker's
// durable gxhost labels. Installer containers are deliberately skipped:
// only the long-lived game container represents a registered server.
func reconcileManagedContainers(ctx context.Context, manager *srv.Manager, dc *dockerx.Client, node spec.Node) (int, error) {
	containers, err := dc.ListManaged(ctx)
	if err != nil {
		return 0, err
	}
	adopted := 0
	for _, item := range containers {
		if item.Labels["gxhost.role"] == "installer" {
			continue
		}
		uuid := item.Labels["gxhost.server.uuid"]
		if uuid == "" {
			continue
		}
		insp, err := dc.InspectContainer(ctx, item.ID)
		if err != nil {
			return adopted, err
		}
		sv, err := recoveredServerSpec(insp.Config.Image, insp.Config.Entrypoint, insp.Config.Cmd, insp.Config.StopSignal, item.Labels, insp.HostConfig)
		if err != nil {
			return adopted, fmt.Errorf("container %s: %w", item.ID, err)
		}
		target, err := manager.Register(sv, node)
		if err != nil {
			return adopted, err
		}
		running := insp.State != nil && insp.State.Running
		if err := target.Adopt(dc, item.ID, running); err != nil {
			return adopted, err
		}
		fmt.Printf("adopted managed container %s for server %s (running=%t)\n", item.ID, uuid, running)
		adopted++
	}
	return adopted, nil
}

func recoveredServerSpec(image string, entrypoint, cmd []string, stopSignal string, labels map[string]string, hc *container.HostConfig) (spec.Server, error) {
	uuid := labels["gxhost.server.uuid"]
	uid, err := strconv.Atoi(labels["gxhost.server.uid"])
	if err != nil || uid <= 0 {
		return spec.Server{}, fmt.Errorf("invalid gxhost.server.uid label")
	}
	argv := append(append([]string{}, entrypoint...), cmd...)
	if image == "" || len(argv) == 0 {
		return spec.Server{}, fmt.Errorf("managed container is missing image or startup command")
	}
	// Docker stores every limit EXCEPT this one (disk has no cgroup on a
	// bind mount — fsx enforces it in-process), so it is read back from
	// the label spec.buildLabels writes at create time. The 1MB
	// placeholder this used to fall back to was worse than having no
	// number at all: fsx.CheckQuota treats <=0 as "unlimited" and returns
	// early, but a 1MB limit made it refuse every upload on a server that
	// had been adopted after an agent restart. Found live on a 6GB server
	// showing "582.2 MB / 1.0 MB · Crítico" right after the boot sweep.
	// Containers created before the label exists fall back to 0: not
	// enforcing a quota until the panel pushes real limits again is a far
	// smaller problem than blocking the customer's uploads outright.
	limits := spec.Limits{DiskMB: parseLabelInt64(labels["gxhost.limits.disk_mb"])}
	if hc != nil {
		limits.MemoryMB = hc.Memory / (1024 * 1024)
		if hc.CPUPeriod > 0 {
			limits.CPUPercent = int(hc.CPUQuota * 100 / hc.CPUPeriod)
		}
		if hc.MemorySwap < 0 {
			limits.SwapMB = -1
		} else if hc.MemorySwap > hc.Memory {
			limits.SwapMB = (hc.MemorySwap - hc.Memory) / (1024 * 1024)
		}
		limits.IOWeight = int(hc.BlkioWeight)
		if hc.PidsLimit != nil {
			limits.PidsLimit = *hc.PidsLimit
		}
	}
	if limits.MemoryMB <= 0 {
		limits.MemoryMB = 1
	}
	return spec.Server{
		UUID: uuid, UID: uid, Image: image,
		StartupTmpl: joinShellArgs(argv), StopSignal: stopSignal,
		Env: map[string]string{}, Limits: limits,
		Allocations: recoveredAllocations(hc),
	}, nil
}

// parseLabelInt64 returns 0 for a missing or malformed label — every
// caller treats 0 as "unknown", never as a real limit.
func parseLabelInt64(value string) int64 {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func recoveredAllocations(hc *container.HostConfig) []spec.Allocation {
	if hc == nil {
		return nil
	}
	type key struct {
		ip   string
		port int
	}
	byAddress := map[key]map[string]bool{}
	for containerPort, bindings := range hc.PortBindings {
		port, err := strconv.Atoi(containerPort.Port())
		if err != nil {
			continue
		}
		for _, binding := range bindings {
			hostPort, err := strconv.Atoi(binding.HostPort)
			if err != nil || hostPort != port {
				continue
			}
			k := key{binding.HostIP, port}
			if byAddress[k] == nil {
				byAddress[k] = map[string]bool{}
			}
			byAddress[k][containerPort.Proto()] = true
		}
	}
	keys := make([]key, 0, len(byAddress))
	for k := range byAddress {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].port == keys[j].port {
			return keys[i].ip < keys[j].ip
		}
		return keys[i].port < keys[j].port
	})
	result := make([]spec.Allocation, 0, len(keys))
	for i, k := range keys {
		protocols := make([]string, 0, len(byAddress[k]))
		for proto := range byAddress[k] {
			protocols = append(protocols, proto)
		}
		sort.Strings(protocols)
		result = append(result, spec.Allocation{IP: k.ip, Port: k.port, Primary: i == 0, Protocols: protocols})
	}
	return result
}

func joinShellArgs(argv []string) string {
	quoted := make([]string, len(argv))
	for i, arg := range argv {
		if arg != "" && strings.IndexFunc(arg, func(r rune) bool {
			return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_./:@%+=,-", r))
		}) == -1 {
			quoted[i] = arg
		} else {
			quoted[i] = "'" + strings.ReplaceAll(arg, "'", "'\\''") + "'"
		}
	}
	return strings.Join(quoted, " ")
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
func runHeartbeatLoop(ctx context.Context, nf config.NodeFile, tokenStore *api.TokenStore, dc *dockerx.Client, manager *srv.Manager) {
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

	// hostinfo.StaticInfo (CPU model/topology, virtualization) is exactly
	// as slow-changing as dockerx.Info — same cache, same TTL. Dynamic
	// values (CPU%, load, memory used/available) are cheap /proc reads
	// and are re-collected every tick, same cadence as disk usage.
	var cachedStatic hostinfo.StaticInfo
	var cachedStaticAt time.Time

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

		if cachedStaticAt.IsZero() || time.Since(cachedStaticAt) > infoCacheTTL {
			cachedStatic = hostinfo.CollectStatic()
			cachedStaticAt = time.Now()
		}
		req.ReportedCPUModel = cachedStatic.CPUModel
		req.ReportedVirtualizationSystem = cachedStatic.VirtualizationSystem
		req.ReportedVirtualizationRole = cachedStatic.VirtualizationRole
		if cachedStatic.PhysicalTopologyReliable {
			req.ReportedCPUPhysicalCores = cachedStatic.CPUPhysicalCores
			req.ReportedCPUSockets = cachedStatic.CPUSockets
		}
		if cachedStatic.MemoryLimitValid {
			req.ReportedMemoryLimitMb = int64(cachedStatic.MemoryLimitBytes / (1024 * 1024))
		}

		dynamic := hostinfo.CollectDynamic()
		if dynamic.CPUUsagePercent >= 0 {
			req.ReportedCPUUsagePercent = dynamic.CPUUsagePercent
		}
		if dynamic.LoadAvgValid {
			req.ReportedLoadAvg1 = dynamic.LoadAvg1
		}
		if dynamic.MemoryValid {
			req.ReportedMemoryUsedMb = int64(dynamic.MemoryUsedBytes / (1024 * 1024))
			req.ReportedMemoryAvailableMb = int64(dynamic.MemoryAvailableBytes / (1024 * 1024))
		}

		// The panel's only source of truth for `servers.power_state` —
		// a full snapshot each tick, so a state the panel missed (a
		// dropped call, a container that crashed on its own, an agent
		// restart) self-corrects on the next one instead of drifting
		// permanently. See srv.Manager.States for why a server busy
		// with a Docker call is omitted rather than waited on.
		for uuid, state := range manager.States() {
			req.Servers = append(req.Servers, panel.ServerPowerState{UUID: uuid, State: string(state)})
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

// orphanReconcileInterval bounds how long a container can stay orphaned
// (its server row deleted while this agent was down/unreachable, or the
// delete itself losing the race with the manager's in-memory registry
// after a restart — see srv.ReconcileOrphans' doc comment) before this
// sweep finds and removes it on its own. There is no real Docker-event/
// reconnect-driven listener yet (architecture doc 4.1's "full reconciliation
// sweep on every reconnect" is a later milestone), so a ticker is today's
// bounded stand-in — 5 minutes keeps a leaked port from staying blocked for
// long without hammering the panel's new list-servers endpoint every tick.
const orphanReconcileInterval = 5 * time.Minute

// runReconcileLoop is the safety net for srv.ReconcileOrphans: it asks the
// panel which server UUIDs should still exist on this node and tears down
// any managed container Docker still has that isn't in that set. Runs
// once immediately (so a restart's own orphans, if any, are caught within
// this one bounded delay rather than waiting a full tick) and then on
// orphanReconcileInterval for as long as the process runs. A failure
// (panel unreachable, Docker list call failing) is logged and retried
// next tick, same non-fatal posture as every other background loop here —
// a panel outage must not take down a node's already-running game servers.
func runReconcileLoop(ctx context.Context, manager *srv.Manager, nf config.NodeFile, tokenStore *api.TokenStore, dc *dockerx.Client) {
	client := panel.New(nf.PanelURL)
	log := slog.Default()

	reconcile := func() {
		reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		resp, err := client.ListServers(reqCtx, tokenStore.Get())
		if err != nil {
			fmt.Printf("orphan reconcile: failed to fetch known servers (will retry in %s): %v\n", orphanReconcileInterval, err)
			return
		}
		known := make(map[string]bool, len(resp.ServerUUIDs))
		for _, uuid := range resp.ServerUUIDs {
			known[uuid] = true
		}
		removed, err := srv.ReconcileOrphans(reqCtx, manager, dc, known, log)
		if err != nil {
			fmt.Printf("orphan reconcile: sweep failed (will retry in %s): %v\n", orphanReconcileInterval, err)
			return
		}
		if len(removed) > 0 {
			fmt.Printf("orphan reconcile: removed %d orphaned container(s) with no matching server: %v\n", len(removed), removed)
		}

		// The OTHER direction, which nothing used to check: tell the panel
		// exactly which servers this node actually holds, so it can notice
		// one of its OWN rows whose container is gone. Reported after the
		// sweep above, so a container this tick just removed is already out
		// of the manager rather than being claimed as present. Best-effort:
		// a failure here must never discard the sweep that already
		// succeeded.
		if err := client.ReportInventory(reqCtx, tokenStore.Get(), panel.InventoryRequest{ServerUUIDs: manager.UUIDs()}); err != nil {
			fmt.Printf("orphan reconcile: failed to report inventory (will retry in %s): %v\n", orphanReconcileInterval, err)
		}
	}

	reconcile()
	ticker := time.NewTicker(orphanReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reconcile()
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
