package srv

import "testing"

// TestClassifyStreamEnd_CrashedContainer is the exact production shape
// this was added for: a Paper server whose JVM exited immediately on a
// corrupt jar, while the panel kept showing RUNNING with a ticking uptime
// because nothing ever moved the state off StateRunning.
func TestClassifyStreamEnd_CrashedContainer(t *testing.T) {
	got := classifyStreamEnd(StateRunning, false, true, false, 1)
	if got != outcomeCrashed {
		t.Fatalf("a running server whose container exited non-zero should be crashed, got %v", got)
	}
}

func TestClassifyStreamEnd_CleanExitIsNotACrash(t *testing.T) {
	got := classifyStreamEnd(StateRunning, false, true, false, 0)
	if got != outcomeExited {
		t.Fatalf("exit code 0 (an in-game /stop) should be a clean exit, got %v", got)
	}
}

func TestClassifyStreamEnd_DeliberateStopIsIgnored(t *testing.T) {
	// Stop()/Kill() set the state and tear the collector down themselves;
	// the stream ending afterwards must never be re-interpreted here.
	// StateStarting is deliberately NOT in this list any more — see
	// TestClassifyStreamEnd_CrashDuringStartingIsDetected just below for
	// why that state now gets classified for real instead of ignored.
	for _, state := range []State{StateOffline, StateStopping, StateCrashed} {
		if got := classifyStreamEnd(state, false, true, false, 137); got != outcomeIgnore {
			t.Fatalf("state %q: a stream ending after a deliberate transition must be ignored, got %v", state, got)
		}
	}
}

// TestClassifyStreamEnd_CrashDuringStartingIsDetected is the reason
// StateStarting moved out of the ignore-list above: Start() no longer
// flips straight to StateRunning (awaitReady only promotes once the
// boot-done log line appears), so a JVM that dies BEFORE that line —
// exactly the corrupt-jar shape TestClassifyStreamEnd_CrashedContainer
// covers for StateRunning — needs the identical detection during
// StateStarting, or it would sit unclassified until awaitReady's
// multi-minute safety timeout, still reading "Iniciando" the whole time.
func TestClassifyStreamEnd_CrashDuringStartingIsDetected(t *testing.T) {
	got := classifyStreamEnd(StateStarting, false, true, false, 1)
	if got != outcomeCrashed {
		t.Fatalf("a server that dies before its boot-done line should be crashed, got %v", got)
	}
}

// The clean-exit counterpart: a customer who stops the server through
// Docker directly (or a template whose install script legitimately exits
// early) while it's still starting is not a crash.
func TestClassifyStreamEnd_CleanExitDuringStartingIsNotACrash(t *testing.T) {
	got := classifyStreamEnd(StateStarting, false, true, false, 0)
	if got != outcomeExited {
		t.Fatalf("exit code 0 while starting should be a clean exit, got %v", got)
	}
}

func TestClassifyStreamEnd_AgentShutdownIsIgnored(t *testing.T) {
	// Every container's stream ends when the agent itself goes down —
	// that says nothing about the container's own health.
	if got := classifyStreamEnd(StateRunning, true, true, false, 1); got != outcomeIgnore {
		t.Fatalf("an agent shutdown must never be recorded as a crash, got %v", got)
	}
}

func TestClassifyStreamEnd_StillRunningIsIgnored(t *testing.T) {
	// The stream dropped but the container is alive — a blip, not a crash.
	if got := classifyStreamEnd(StateRunning, false, true, true, 0); got != outcomeIgnore {
		t.Fatalf("a still-running container must never be flagged as stopped, got %v", got)
	}
}

func TestClassifyStreamEnd_UninspectableContainerIsIgnored(t *testing.T) {
	// A delete racing this check removes the container out from under the
	// inspect; guessing "crashed" there would flip a server that no
	// longer exists into a failure state.
	if got := classifyStreamEnd(StateRunning, false, false, false, 0); got != outcomeIgnore {
		t.Fatalf("an uninspectable container must never be guessed at, got %v", got)
	}
}
