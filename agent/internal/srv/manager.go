package srv

import (
	"fmt"
	"sync"

	"github.com/pxhost/agent/internal/spec"
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

func (m *Manager) List() []*Server {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Server, 0, len(m.servers))
	for _, s := range m.servers {
		out = append(out, s)
	}
	return out
}
