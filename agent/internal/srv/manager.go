package srv

import (
	"fmt"
	"sync"

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
