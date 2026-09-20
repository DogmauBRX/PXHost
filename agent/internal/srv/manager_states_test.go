package srv

import (
	"testing"

	"github.com/gxhost/agent/internal/spec"
)

// The panel's servers.power_state has exactly one writer — the heartbeat,
// fed by Manager.States. These pin down the two properties the panel
// depends on: a settled server is always reported, and a server busy with
// a Docker call is OMITTED rather than waited on (blocking here would
// delay the heartbeat that also carries the node's own health, and the
// panel treats an absent entry as "no news", never as offline).

func registerTestServer(t *testing.T, m *Manager, uuid string) *Server {
	t.Helper()
	s, err := m.Register(spec.Server{UUID: uuid}, spec.Node{})
	if err != nil {
		t.Fatalf("Register(%s): %v", uuid, err)
	}
	return s
}

func TestStatesReportsEveryIdleServer(t *testing.T) {
	m := NewManager()
	a := registerTestServer(t, m, "11111111-1111-1111-1111-111111111111")
	b := registerTestServer(t, m, "22222222-2222-2222-2222-222222222222")
	a.State = StateRunning
	b.State = StateCrashed

	got := m.States()

	if len(got) != 2 {
		t.Fatalf("States() returned %d entries, want 2: %v", len(got), got)
	}
	if got[a.UUID] != StateRunning {
		t.Errorf("server a: got %q, want %q", got[a.UUID], StateRunning)
	}
	if got[b.UUID] != StateCrashed {
		t.Errorf("server b: got %q, want %q", got[b.UUID], StateCrashed)
	}
}

func TestStatesOmitsBusyServerInsteadOfBlocking(t *testing.T) {
	m := NewManager()
	busy := registerTestServer(t, m, "11111111-1111-1111-1111-111111111111")
	idle := registerTestServer(t, m, "22222222-2222-2222-2222-222222222222")
	idle.State = StateRunning

	// Exactly what a start/stop holds while Docker works.
	busy.mu.Lock()
	defer busy.mu.Unlock()

	// If States() took the lock instead of TryLock, this call would
	// deadlock against the line above and the test would time out —
	// which is the real failure mode being guarded: a stalled heartbeat
	// marks the whole NODE offline, far worse than a late power state.
	got := m.States()

	if _, reported := got[busy.UUID]; reported {
		t.Errorf("busy server was reported (%q); it must be omitted until its state settles", got[busy.UUID])
	}
	if got[idle.UUID] != StateRunning {
		t.Errorf("idle server should still be reported while another is busy: got %q", got[idle.UUID])
	}
}

func TestStatesOnEmptyManagerReportsNothing(t *testing.T) {
	// An empty map, not nil-vs-empty trickery: the caller appends it into
	// the heartbeat's `omitempty` slice, so "no servers" must produce no
	// entries and therefore no `servers` key at all — the panel then
	// leaves every row untouched rather than defaulting anything.
	if got := NewManager().States(); len(got) != 0 {
		t.Errorf("States() on an empty manager returned %v, want no entries", got)
	}
}
