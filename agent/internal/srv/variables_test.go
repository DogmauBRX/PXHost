package srv

import (
	"context"
	"testing"
)

// TestServer_UpdateVariablesRefusesWhenNotOffline exercises the guard in
// isolation, before any real Docker call — same reasoning as
// TestServer_StartRefusesWhenSuspended in suspend_test.go: the guard is
// the first thing UpdateVariables checks, so a nil dockerFull never gets
// touched. The actual remove+recreate mechanics are proven live, not
// here — see this package's other tests' notes on dockerFull being a
// concrete type with no fake-able seam.
func TestServer_UpdateVariablesRefusesWhenNotOffline(t *testing.T) {
	s, _ := newBackupTestServer(t)
	s.State = StateRunning

	if err := s.UpdateVariables(context.Background(), nil, map[string]string{"FOO": "bar"}); err == nil {
		t.Fatal("UpdateVariables on a running server: got nil error, want a refusal")
	}
}

func TestServer_UpdateVariablesRefusesWhenStarting(t *testing.T) {
	s, _ := newBackupTestServer(t)
	s.State = StateStarting

	if err := s.UpdateVariables(context.Background(), nil, map[string]string{"FOO": "bar"}); err == nil {
		t.Fatal("UpdateVariables while starting: got nil error, want a refusal")
	}
}
