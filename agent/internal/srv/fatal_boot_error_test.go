package srv

import "testing"

func TestIsFatalBootErrorLine(t *testing.T) {
	cases := []struct {
		name string
		line string
		want bool
	}{
		{"vanilla/forge/neoforge's own top-level failure line", `[17:56:07] [main/ERROR] [minecraft/Main]: Failed to start the minecraft server`, true},
		{"no timestamp/thread prefix at all", `Failed to start the minecraft server`, true},
		{"an ordinary boot line", `[09:15:20] [Server thread/INFO]: Starting Minecraft server on *:25565`, false},
		{"a line that merely mentions starting something else", `[09:15:25] [Server thread/INFO]: Starting remote control listener`, false},
		{"empty line", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isFatalBootErrorLine(c.line); got != c.want {
				t.Errorf("isFatalBootErrorLine(%q) = %v, want %v", c.line, got, c.want)
			}
		})
	}
}

// handleFatalBootError's real-Docker half (killing the stuck container) is
// proven live, not here — see suspend_test.go's own note on dockerFull
// being a concrete type with no fake-able seam. An empty ContainerID keeps
// this test on the pure state-transition side of that boundary: it never
// reaches the dc.KillContainer call, so a nil dc is safe to pass.
func TestHandleFatalBootErrorOnlyAppliesFromStarting(t *testing.T) {
	s, _ := newBackupTestServer(t)

	s.mu.Lock()
	s.State = StateOffline
	s.mu.Unlock()
	s.handleFatalBootError(nil)
	if got := s.currentState(); got != StateOffline {
		t.Fatalf("handleFatalBootError from StateOffline: got %v, want unchanged StateOffline", got)
	}

	s.mu.Lock()
	s.State = StateRunning
	s.mu.Unlock()
	s.handleFatalBootError(nil)
	if got := s.currentState(); got != StateRunning {
		t.Fatalf("handleFatalBootError from StateRunning: got %v, want unchanged StateRunning", got)
	}

	s.mu.Lock()
	s.State = StateStarting
	s.mu.Unlock()
	s.handleFatalBootError(nil)
	if got := s.currentState(); got != StateCrashed {
		t.Fatalf("handleFatalBootError from StateStarting: got %v, want StateCrashed", got)
	}
}
