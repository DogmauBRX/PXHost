// Package srv owns per-server lifecycle: turning a spec into a running
// container and sequencing power actions safely. It is the only package
// that is allowed to call dockerx for a managed game-server container.
package srv

import (
	"context"
	"fmt"
	"os"
	"path"
	"sync"
	"time"

	"github.com/pxhost/agent/internal/console"
	"github.com/pxhost/agent/internal/dockerx"
	"github.com/pxhost/agent/internal/fsx"
	"github.com/pxhost/agent/internal/spec"
	"github.com/pxhost/agent/internal/stats"
)

// State is the agent-local runtime state machine. It mirrors
// servers.power_state in the architecture doc (2.7): the agent only ever
// reports this to the panel, never accepts a requested value from it.
type State string

const (
	StateOffline  State = "offline"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateStopping State = "stopping"
	StateCrashed  State = "crashed"
)

// Server is one game server's in-memory handle. All Docker calls for this
// server are serialized through mu, so a stop and a concurrent start can
// never race each other into an inconsistent container.
//
// It also owns the two long-lived, container-scoped background workers
// described in architecture doc 4.5: a console.Pump (attached BEFORE start
// so no boot output is lost) and a stats.Collector. Both keep running
// independent of any particular HTTP/WS request's context — they are tied
// to bgCtx, which lives for as long as the Server itself.
type Server struct {
	mu sync.Mutex

	UUID          string
	ContainerName string
	ContainerID   string // empty until created
	State         State

	Hub *console.Hub // console.Ring + fanout; safe to read/subscribe at any time, even offline

	// Jail is this server's filesystem jail (architecture doc 4.4),
	// opened once here at registration — not lazily on first file
	// request — matching the doc's own stated lifecycle. Every
	// customer-facing file operation goes through it, never a bare
	// os.Open/os.ReadFile against DataDir+UUID by hand.
	Jail *fsx.Jail

	spec spec.Server
	node spec.Node

	stopTimeout time.Duration

	bgCtx    context.Context
	bgCancel context.CancelFunc

	pump      *console.Pump
	collector *stats.Collector
}

// New creates a server's in-memory handle AND its data directory
// (<node.DataDir>/<uuid>), owned 0750 by the agent itself — this is
// deliberately no longer left to Docker's own "auto-create a missing
// bind-mount source" side effect (see the M5 agent README's own note
// that this was fsx's job for "a later milestone" — this is that
// milestone). The jail is opened against that directory immediately, so
// it's ready before the container is ever created.
func New(s spec.Server, node spec.Node) (*Server, error) {
	dataDir := path.Join(node.DataDir, s.UUID)
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return nil, fmt.Errorf("srv: creating data dir %q: %w", dataDir, err)
	}
	jail, err := fsx.Open(dataDir)
	if err != nil {
		return nil, fmt.Errorf("srv: opening filesystem jail: %w", err)
	}

	bgCtx, cancel := context.WithCancel(context.Background())
	return &Server{
		UUID:          s.UUID,
		ContainerName: containerName(s.UUID),
		State:         StateOffline,
		Hub:           console.NewHub(console.NewRing()),
		Jail:          jail,
		spec:          s,
		node:          node,
		stopTimeout:   30 * time.Second,
		bgCtx:         bgCtx,
		bgCancel:      cancel,
	}, nil
}

func containerName(uuid string) string {
	return "pxhost-" + uuid
}

// dockerFull is the Docker client type every lifecycle method takes. It is
// also what satisfies console.Attacher and stats.StatsSource (both narrow
// interfaces this package's docker client already implements structurally),
// which is why Start can pass dc straight into console.Start and
// stats.NewCollector with no adapter.
type dockerFull = *dockerx.Client

// Create builds the container spec (spec.BuildContainerSpec — the pure,
// unit-tested function) and asks Docker to create the container. It does
// not start it: install/reinstall flows may need to run before first boot.
func (s *Server) Create(ctx context.Context, dc dockerFull) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ContainerID != "" {
		return fmt.Errorf("srv: server %s already has a container (%s)", s.UUID, s.ContainerID)
	}

	cfg, hostCfg, netCfg, err := spec.BuildContainerSpec(s.spec, s.node)
	if err != nil {
		return fmt.Errorf("srv: building spec for %s: %w", s.UUID, err)
	}

	id, err := dc.CreateContainer(ctx, s.ContainerName, cfg, hostCfg, netCfg)
	if err != nil {
		return err
	}
	s.ContainerID = id
	s.State = StateOffline
	return nil
}

// UpdateLimits applies a new set of resource limits (architecture doc
// roadmap M12: "plan-apply ... works" — the panel pushing a plan edit
// onto every server still on that plan). The in-memory spec is updated
// unconditionally — MemoryLimitMB()/CPULimitPercent()/DiskLimitMB()
// (the last one is what fsx's quota accountant compares against; disk
// has no cgroup equivalent, architecture doc 9.1) must reflect the new
// intent even if the live Docker call below fails or there is no
// container yet to update. If a container DOES exist, spec.BuildResources
// computes byte-for-byte the same values Create would have used, so a
// server updated-then-restarted and a server created fresh with the new
// limits end up identical — never two divergent code paths for the same
// math.
func (s *Server) UpdateLimits(ctx context.Context, dc dockerFull, newLimits spec.Limits) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.spec.Limits = newLimits
	if s.ContainerID == "" {
		return nil
	}
	return dc.UpdateContainer(ctx, s.ContainerID, spec.BuildResources(newLimits, s.node))
}

// Start starts the container. Per architecture doc 4.5 ("attach first,
// then start" — attaching after start can lose the first lines of boot
// output), the console pump is attached BEFORE the Docker start call, and
// the stats collector begins immediately after.
func (s *Server) Start(ctx context.Context, dc dockerFull) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ContainerID == "" {
		return fmt.Errorf("srv: server %s has no container to start; call Create first", s.UUID)
	}
	if s.State == StateRunning || s.State == StateStarting {
		return fmt.Errorf("srv: server %s is already %s", s.UUID, s.State)
	}
	if s.spec.IsSuspended {
		// The second of two independent enforcement points (architecture
		// doc roadmap M14/2.5) — this refusal holds even if the panel
		// itself is compromised or simply hasn't caught up to a recent
		// suspension yet.
		return fmt.Errorf("%w: server %s", ErrServerSuspended, s.UUID)
	}

	// Deliberately attaches using s.bgCtx, NOT the caller's ctx: this attach
	// is a long-lived streaming connection that must outlive whatever
	// short-lived request triggered Start (an HTTP power-action handler or
	// a WS power:set frame). Using the request-scoped ctx here was a real
	// bug found while smoke-testing this milestone: the console attach
	// would establish successfully, but console input written moments
	// later silently went nowhere once the triggering request's context
	// was cancelled — the container's own logs proved the byte never
	// arrived, while attaching the exact same container by hand (`docker
	// attach`, no request-scoped context involved) worked immediately.
	pump, err := console.Start(s.bgCtx, dc, s.ContainerID, s.Hub)
	if err != nil {
		return fmt.Errorf("srv: attaching console before start: %w", err)
	}
	s.pump = pump

	s.State = StateStarting
	if err := dc.StartContainer(ctx, s.ContainerID); err != nil {
		s.State = StateCrashed
		_ = s.pump.Close()
		s.pump = nil
		return err
	}
	// M3 (Docker event listener) promotes starting->running from the real
	// event stream / the template's log "ready" marker. For M2's direct
	// power-action flow, we mark running immediately after a successful
	// start call — good enough until the event listener lands.
	s.State = StateRunning

	memLimitBytes := uint64(s.spec.Limits.MemoryMB) * 1024 * 1024
	cpuLimitPercent := uint64(s.spec.Limits.CPUPercent)
	s.collector = stats.NewCollector(dc, s.ContainerID, memLimitBytes, cpuLimitPercent, nil, nil)
	go func() {
		_ = s.collector.Run(s.bgCtx)
	}()

	return nil
}

// Stop performs a graceful stop: Docker's ContainerStop sends the
// configured stop signal and waits up to stopTimeout before the daemon
// itself escalates to SIGKILL. The console pump and stats collector are
// torn down only after the container has actually stopped, so crash/exit
// output is never lost.
func (s *Server) Stop(ctx context.Context, dc dockerFull) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ContainerID == "" {
		return fmt.Errorf("srv: server %s has no container to stop", s.UUID)
	}
	if s.State == StateOffline || s.State == StateStopping {
		return fmt.Errorf("srv: server %s is already %s", s.UUID, s.State)
	}

	s.State = StateStopping
	if err := dc.StopContainer(ctx, s.ContainerID, s.stopTimeout); err != nil {
		// Found live (M10): left at StateStopping forever otherwise — the
		// mirror-image of the bug this exact pattern avoids in Start()
		// just above. A caller's context can be cancelled (an HTTP
		// request's own client-side abort/timeout) while Docker's stop is
		// still in flight server-side; when that happens here, every
		// future Stop() call hit the "already stopping" guard below and
		// failed immediately, forever, with no way back to a working
		// state short of a Start() (whose guard doesn't check for
		// StateStopping). StateCrashed — same terminal-on-error state
		// Start() already uses — keeps this recoverable: neither Stop()'s
		// nor Start()'s guard blocks on it, so the next attempt of either
		// can proceed normally instead of being stuck.
		s.State = StateCrashed
		return err
	}
	s.State = StateOffline
	s.teardownRuntimeLocked()
	return nil
}

// Kill sends SIGKILL immediately — the escalation path when a graceful
// stop has already timed out, or an explicit force action from the panel.
func (s *Server) Kill(ctx context.Context, dc dockerFull) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ContainerID == "" {
		return fmt.Errorf("srv: server %s has no container to kill", s.UUID)
	}
	if err := dc.KillContainer(ctx, s.ContainerID); err != nil {
		return err
	}
	s.State = StateOffline
	s.teardownRuntimeLocked()
	return nil
}

// UpdateVariables rebuilds the container with a new environment — Docker
// env is immutable after creation, so a variable edit is a remove+recreate
// of the CONTAINER only. Unlike Remove (the real-deletion path), this
// deliberately never cancels bgCtx or closes the Jail: the data directory,
// this Server's identity in the manager, and its console Hub/history all
// survive untouched, exactly the same way Remove already leaves the data
// directory on disk for a later re-create.
//
// Requires the server to already be stopped. Recreating a running
// container out from under an attached console pump and stats collector
// is a different, harder problem this endpoint doesn't attempt — the
// caller (panel) is expected to refuse the edit in the UI while running,
// but this guard is the real enforcement point per architecture doc 2.5.
func (s *Server) UpdateVariables(ctx context.Context, dc dockerFull, newEnv map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.State != StateOffline {
		return fmt.Errorf("srv: server %s must be stopped before its variables can be updated", s.UUID)
	}

	if s.ContainerID != "" {
		if err := dc.RemoveContainer(ctx, s.ContainerID, true); err != nil {
			return fmt.Errorf("srv: removing old container before recreate: %w", err)
		}
		s.ContainerID = ""
	}

	s.spec.Env = newEnv

	cfg, hostCfg, netCfg, err := spec.BuildContainerSpec(s.spec, s.node)
	if err != nil {
		return fmt.Errorf("srv: building spec for %s: %w", s.UUID, err)
	}
	id, err := dc.CreateContainer(ctx, s.ContainerName, cfg, hostCfg, netCfg)
	if err != nil {
		return fmt.Errorf("srv: recreating container: %w", err)
	}
	s.ContainerID = id
	return nil
}

// Remove force-removes the container. It does not touch the server's data
// directory — deletion of on-disk data is a separate, explicit operation
// (fsx, later milestone), never implied by removing the container.
func (s *Server) Remove(ctx context.Context, dc dockerFull) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.teardownRuntimeLocked()
	s.bgCancel()
	if s.Jail != nil {
		_ = s.Jail.Close()
	}

	if s.ContainerID == "" {
		return nil
	}
	if err := dc.RemoveContainer(ctx, s.ContainerID, true); err != nil {
		return err
	}
	s.ContainerID = ""
	s.State = StateOffline
	return nil
}

// teardownRuntimeLocked stops the console pump and stats collector for the
// container that just stopped/was killed. Must be called with mu held.
func (s *Server) teardownRuntimeLocked() {
	if s.pump != nil {
		_ = s.pump.Close()
		s.pump = nil
	}
	if s.collector != nil {
		s.collector.Stop()
		s.collector = nil
	}
}

// LatestStats returns the most recent stats frame, or the zero value if
// the server isn't running / no sample has arrived yet.
func (s *Server) LatestStats() (stats.Frame, bool) {
	s.mu.Lock()
	c := s.collector
	s.mu.Unlock()
	if c == nil {
		return stats.Frame{}, false
	}
	return c.Latest(), true
}

// WriteConsole sends already-sanitized bytes to the running container's
// stdin. Returns an error if the server isn't currently running.
func (s *Server) WriteConsole(line string) error {
	s.mu.Lock()
	p := s.pump
	st := s.State
	s.mu.Unlock()

	if p == nil || st != StateRunning {
		return fmt.Errorf("srv: server %s is not running", s.UUID)
	}
	_, err := p.Write([]byte(line + "\n"))
	return err
}

// MemoryLimitMB / CPULimitPercent expose the server's configured limits so
// the API layer can report them without reaching back into spec.Server.
func (s *Server) MemoryLimitMB() int64 { return s.spec.Limits.MemoryMB }
func (s *Server) CPULimitPercent() int { return s.spec.Limits.CPUPercent }
func (s *Server) UID() int             { return s.spec.UID }
func (s *Server) DiskLimitMB() int64   { return s.spec.Limits.DiskMB }
