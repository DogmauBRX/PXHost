package srv

import "testing"

// isReadyLine is the exact rule that decides when a server stops showing
// "Iniciando" and starts showing "Ativo" with a counting uptime — see
// Start()'s own doc comment for the live bug (every consumer treated
// "container exists" and "world finished loading" as the same moment)
// this exists to fix.
func TestIsReadyLine(t *testing.T) {
	cases := []struct {
		name string
		line string
		want bool
	}{
		{"vanilla/paper/purpur", `[09:15:32] [Server thread/INFO]: Done (12.345s)! For help, type "help"`, true},
		{"forge/neoforge (own logger prefix)", `[09:15:32] [Server thread/INFO] [minecraft/DedicatedServer]: Done (83.276s)! For help, type "help"`, true},
		{"no timestamp prefix at all", `Done (4.2s)! For help, type "help"`, true},
		{"an ordinary boot line", `[09:15:20] [Server thread/INFO]: Starting Minecraft server on *:25565`, false},
		{"a line that merely mentions being done with something else", `[09:15:25] [Server thread/INFO]: Preparing spawn area: 100%`, false},
		{"empty line", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isReadyLine(c.line); got != c.want {
				t.Errorf("isReadyLine(%q) = %v, want %v", c.line, got, c.want)
			}
		})
	}
}

// promoteStartingTo must be a no-op from any state other than
// StateStarting — awaitReady can fire (marker seen, or its timeout)
// after a concurrent Stop/Kill/crash already decided the server's real
// state, and that decision must win.
func TestPromoteStartingToOnlyAppliesFromStarting(t *testing.T) {
	s, _ := newBackupTestServer(t)

	s.mu.Lock()
	s.State = StateOffline
	s.mu.Unlock()
	s.promoteStartingTo(StateRunning)
	if got := s.currentState(); got != StateOffline {
		t.Fatalf("promoteStartingTo from StateOffline: got %v, want unchanged StateOffline", got)
	}

	s.mu.Lock()
	s.State = StateCrashed
	s.mu.Unlock()
	s.promoteStartingTo(StateRunning)
	if got := s.currentState(); got != StateCrashed {
		t.Fatalf("promoteStartingTo from StateCrashed: got %v, want unchanged StateCrashed", got)
	}

	s.mu.Lock()
	s.State = StateStarting
	s.mu.Unlock()
	s.promoteStartingTo(StateRunning)
	if got := s.currentState(); got != StateRunning {
		t.Fatalf("promoteStartingTo from StateStarting: got %v, want StateRunning", got)
	}
}

func TestIsStartingReflectsCurrentState(t *testing.T) {
	s, _ := newBackupTestServer(t)

	s.mu.Lock()
	s.State = StateStarting
	s.mu.Unlock()
	if !s.isStarting() {
		t.Fatal("isStarting() should be true while State == StateStarting")
	}

	s.mu.Lock()
	s.State = StateRunning
	s.mu.Unlock()
	if s.isStarting() {
		t.Fatal("isStarting() should be false once State has moved past StateStarting")
	}
}

func (s *Server) currentState() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.State
}
