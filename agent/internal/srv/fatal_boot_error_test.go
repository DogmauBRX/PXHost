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

// The live failure: a 318-mod pack prints its mod table in one burst, a
// boot subscriber's 256-line buffer overflows, and the "Failed to start"
// line that follows is dropped from the channel. The scanner reads the
// ring, which keeps it.
func TestBootScannerFindsFatalLineDroppedFromASubscriber(t *testing.T) {
	s, _ := newBackupTestServer(t)
	s.Hub.Publish("stdout", "line before this boot")
	from := s.Hub.LastSeq()
	sub := s.Hub.Subscribe()
	defer s.Hub.Unsubscribe(sub)
	for i := 0; i < 300; i++ {
		s.Hub.Publish("stdout", "| mod table row |")
	}
	s.Hub.Publish("stdout", "[main/ERROR] [minecraft/Main]: Failed to start the minecraft server")

	if dropped := sub.TakeDropped(); dropped == 0 {
		t.Fatal("test setup: expected the subscriber to have dropped lines")
	}
	if got := newBootScanner(s.Hub, from).next(); got != bootFailed {
		t.Fatalf("scanner outcome = %v, want bootFailed", got)
	}
}

func TestBootScannerIgnoresLinesFromBeforeThisBootAndResumes(t *testing.T) {
	s, _ := newBackupTestServer(t)
	s.Hub.Publish("stdout", `[old run] Done (3.2s)! For help, type "help"`)
	scan := newBootScanner(s.Hub, s.Hub.LastSeq())

	s.Hub.Publish("stdout", "Loading 318 mods")
	if got := scan.next(); got != bootPending {
		t.Fatalf("before the ready line: got %v, want bootPending", got)
	}
	s.Hub.Publish("stdout", `[Server thread/INFO]: Done (41.0s)! For help, type "help"`)
	if got := scan.next(); got != bootReady {
		t.Fatalf("after the ready line: got %v, want bootReady", got)
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
