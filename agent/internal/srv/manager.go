package srv

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gxhost/agent/internal/spec"
)

// Manager is the registry of every server this agent knows about. In the
// full agent (M3+) it is rebuilt from Docker container labels on every
// boot rather than persisted anywhere — the agent itself holds no
// database (architecture doc 4.1).
type Manager struct {
	mu      sync.RWMutex
	servers map[string]*Server
}

func NewManager() *Manager {
	return &Manager{servers: make(map[string]*Server)}
}

func (m *Manager) Register(s spec.Server, node spec.Node) (*Server, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.servers[s.UUID]; exists {
		return nil, fmt.Errorf("srv: server %s is already registered", s.UUID)
	}
	srv, err := New(s, node)
	if err != nil {
		return nil, err
	}
	m.servers[s.UUID] = srv
	return srv, nil
}

func (m *Manager) Get(uuid string) (*Server, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.servers[uuid]
	return s, ok
}

func (m *Manager) Remove(uuid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.servers, uuid)
}

// States snapshots every registered server's power state for the
// heartbeat to report (architecture doc 2.7: the agent reports this to
// the panel, never accepts it from there). The panel's `servers.power_state`
// had no writer at all before this — it sat at its `'offline'` default
// forever while containers ran, so the panel showed every server as
// offline and a version-change's "must be offline" precondition could
// never actually reject anything.
//
// Reported as a full snapshot every tick rather than on each transition:
// the bug being fixed IS drift, and a transition-only report re-creates
// it the moment one call is dropped, a container crashes on its own, or
// the agent restarts. A periodic snapshot reconciles itself.
//
// TryLock, not Lock: `Server.mu` is held across Docker calls that can
// take many seconds (a graceful stop waits for the JVM), and blocking
// here would stall the heartbeat that also carries this node's own
// health — a DELAYED heartbeat would mark the whole node offline, which
// is far worse than a late power state. A server mid-transition is
// simply omitted from this tick; it is also exactly the server whose
// state is ambiguous right now, and the panel leaves an omitted server
// untouched rather than guessing (the same best-effort contract every
// other heartbeat field already follows). The next tick, 15s later,
// reports it settled.
func (m *Manager) States() map[string]State {
	m.mu.RLock()
	servers := make([]*Server, 0, len(m.servers))
	for _, s := range m.servers {
		servers = append(servers, s)
	}
	m.mu.RUnlock()

	out := make(map[string]State, len(servers))
	for _, s := range servers {
		if !s.mu.TryLock() {
			continue // busy with a Docker call — its state is in flux, report it next tick
		}
		out[s.UUID] = s.State
		s.mu.Unlock()
	}
	return out
}

// UUIDs is the agent's COMPLETE inventory: every server it has registered,
// whether or not it is busy. Deliberately distinct from States above,
// which omits a server mid-Docker-call — for "does this server exist on
// this node at all?" an omission must never be ambiguous.
//
// The panel needs this because reconciliation used to run in ONE
// direction only: ReconcileOrphans tears down a CONTAINER with no
// matching server on the panel, but nothing ever noticed the reverse —
// a server the panel still lists whose container is gone from the node.
// Such a server sits in `installing` forever (there is no stuck-install
// watchdog either) while every operation on it answers
// SERVER_NOT_FOUND, with no path back short of manual intervention. Seen
// live: a container removed during debugging, then an agent restart,
// which rebuilds this registry from Docker labels alone and so forgot
// the server entirely.
//
// The agent deliberately reports raw inventory and draws no conclusion:
// a `setup_pending` server has no container BY DESIGN (no template
// chosen yet), and only the panel knows a server's status. Deciding here
// would mean teaching the agent the panel's lifecycle — and getting it
// wrong would condemn healthy servers.
func (m *Manager) UUIDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]string, 0, len(m.servers))
	for uuid := range m.servers {
		out = append(out, uuid)
	}
	return out
}

// oldDirSuffixes are every "swap leftover" naming convention this agent
// uses (modpack.go's install, backup.go's restore) — both are atomic
// rename-swaps that leave the PREVIOUS data directory sitting at
// "<uuid>.modpack-old" / "<uuid>.restore-old" as a short-lived recovery
// copy, normally deleted by a delayed goroutine an hour later. See
// SweepStaleOldDirs' own doc comment for why that goroutine alone isn't
// enough.
var oldDirSuffixes = []string{".modpack-old", ".restore-old"}

// staleOldDirAge is deliberately shorter than the 1-hour delay
// modpack.go/backup.go's own delayed goroutines use for a directory they
// KNOW just got created — this sweep only runs once, at agent startup,
// against directories that could only be genuine leftovers from a PAST
// process lifetime (nothing this same boot has run yet), so there is no
// in-flight swap to race. Still nonzero, not zero, as defense in depth
// against a clock skew or a boot racing something unexpected.
const staleOldDirAge = 5 * time.Minute

// SweepStaleOldDirs removes abandoned "<uuid>.modpack-old" /
// "<uuid>.restore-old" directories directly under dataDir — the OTHER
// half of the leak srv.ReconcileOrphans and the delete-server path fix:
// modpack.go/backup.go's own cleanup goroutines schedule themselves for
// an hour later and are lost entirely if the agent restarts before then
// (found live: several still present on disk from restarts that happened
// hours earlier, one holding ~390MB). Meant to be called once at serve
// startup, before anything else runs.
//
// A "<uuid>.old-suffix" directory is deleted ONLY when its live sibling
// "<uuid>" also exists. Their absence is the one case that must NEVER be
// swept: it means the agent died between renaming the live directory
// AWAY (the swap's first step) and renaming the new content INTO place
// (its second) — the "-old" directory is then the server's ONLY
// remaining copy of its data, not a leftover. Age-gated on top of that as
// defense in depth, not as the primary guard.
//
// Best-effort per entry: one directory this process cannot stat or
// remove (a permissions quirk, a concurrent operator action) must never
// abort the sweep for every other server on the node.
func SweepStaleOldDirs(dataDir string, log *slog.Logger) {
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		log.Warn("stale-old-dir sweep: failed to list data directory", "dir", dataDir, "err", err)
		return
	}

	cutoff := time.Now().Add(-staleOldDirAge)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		var liveUUID string
		for _, suffix := range oldDirSuffixes {
			if strings.HasSuffix(name, suffix) {
				liveUUID = strings.TrimSuffix(name, suffix)
				break
			}
		}
		if liveUUID == "" {
			continue
		}

		oldPath := filepath.Join(dataDir, name)
		livePath := filepath.Join(dataDir, liveUUID)
		if _, err := os.Stat(livePath); err != nil {
			// No live sibling: an incomplete swap, not a leftover. Leave
			// it — this is the case the age gate alone cannot protect
			// against, since the agent could stay down well past
			// staleOldDirAge.
			continue
		}

		info, err := entry.Info()
		if err != nil {
			log.Warn("stale-old-dir sweep: failed to stat entry", "dir", oldPath, "err", err)
			continue
		}
		if info.ModTime().After(cutoff) {
			continue // young enough that its own delayed goroutine, if any, may still be alive
		}

		if err := os.RemoveAll(oldPath); err != nil {
			log.Warn("stale-old-dir sweep: failed to remove", "dir", oldPath, "err", err)
			continue
		}
		log.Warn("stale-old-dir sweep: removed abandoned swap leftover", "dir", oldPath)
	}
}

// ReassertDataDirOwnership re-chowns every registered server's LIVE data
// directory to its own sandboxed uid — the self-healing half of the
// ownership bug backup.go's Restore had (see its own doc comment): a
// server whose directory silently ended up agent-owned (a swap whose
// staging root was never chowned, or any other silent chown(2) failure —
// New()'s own creation-time chown is itself best-effort and, like
// Restore's, never surfaced a failure anywhere) needs SOMETHING that
// notices and fixes it without a person finding the "Permission denied"
// first. Found live: two servers with a live-owned-by-agent directory at
// once, only one of which could be traced to the Restore bug — the other
// had no on-disk evidence of a cause at all, which is exactly what an
// unlogged best-effort chown failure looks like after the fact.
//
// os.Chown is idempotent and cheap on an already-correctly-owned
// directory — this is safe to run on every tick, not just at boot, so a
// FUTURE silent failure (still possible: this doesn't remove every
// best-effort chown elsewhere, it backstops them) self-heals within one
// reconcile interval instead of needing a restart.
func (m *Manager) ReassertDataDirOwnership(log *slog.Logger) {
	m.mu.RLock()
	servers := make([]*Server, 0, len(m.servers))
	for _, s := range m.servers {
		servers = append(servers, s)
	}
	m.mu.RUnlock()

	for _, s := range servers {
		dataDir := filepath.Join(s.node.DataDir, s.UUID)
		if err := os.Chown(dataDir, s.spec.UID, s.spec.UID); err != nil {
			log.Warn("failed to reassert data directory ownership", "uuid", s.UUID, "dir", dataDir, "uid", s.spec.UID, "err", err)
		}
	}
}
