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

// UUIDs is the panel's only way to learn that one of ITS servers has no
// container here. Its contract differs from States on purpose, and the
// difference is what these pin down.
func TestUUIDsReportsBusyServersToo(t *testing.T) {
	m := NewManager()
	idle := registerTestServer(t, m, "11111111-1111-4111-8111-111111111111")
	busy := registerTestServer(t, m, "22222222-2222-4222-8222-222222222222")

	busy.mu.Lock()
	defer busy.mu.Unlock()

	got := m.UUIDs()

	// States omits a busy server (its STATE is ambiguous mid-transition).
	// UUIDs must not: "does this server exist here at all" has an
	// unambiguous answer even while Docker works, and omitting it would
	// tell the panel to flag a perfectly healthy server as missing.
	if len(got) != 2 {
		t.Fatalf("UUIDs() returned %d entries, want 2 (busy servers included): %v", len(got), got)
	}
	seen := map[string]bool{}
	for _, u := range got {
		seen[u] = true
	}
	if !seen[idle.UUID] || !seen[busy.UUID] {
		t.Errorf("UUIDs() = %v, want both %s and %s", got, idle.UUID, busy.UUID)
	}
}

func TestUUIDsOnEmptyManagerIsEmptyNotNil(t *testing.T) {
	// The caller sends this straight to the panel as `serverUuids`, where
	// an empty list MEANS "this node holds nothing" and drives real
	// decisions. A nil that marshalled to JSON `null` instead would be a
	// different message entirely.
	got := NewManager().UUIDs()
	if got == nil {
		t.Fatal("UUIDs() returned nil; an empty node must report an empty list, never null")
	}
	if len(got) != 0 {
		t.Errorf("UUIDs() = %v, want no entries", got)
	}
}

func TestUUIDsDropsRemovedServer(t *testing.T) {
	// The exact sequence behind the bug this feature exists for: a
	// container goes away, so the server leaves the registry, and the
	// panel must be able to see that it is gone.
	m := NewManager()
	s := registerTestServer(t, m, "33333333-3333-4333-8333-333333333333")
	m.Remove(s.UUID)
	if got := m.UUIDs(); len(got) != 0 {
		t.Errorf("UUIDs() = %v after Remove, want no entries", got)
	}
}
