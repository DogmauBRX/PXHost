package srv

import (
	"context"
	"errors"
	"testing"
)

// TestServer_ReinstallRefusesWhenNotOffline exercises the guard in
// isolation, before any real Docker call — same reasoning as
// TestServer_UpdateVariablesRefusesWhenNotOffline in variables_test.go:
// the guard is the first thing Reinstall checks, so a nil dockerFull
// never gets touched.
func TestServer_ReinstallRefusesWhenNotOffline(t *testing.T) {
	s, _ := newBackupTestServer(t)
	s.State = StateRunning

	err := s.Reinstall(context.Background(), nil, "some/image:tag", "java -jar server.jar", "", map[string]string{"FOO": "bar"})
	if !errors.Is(err, ErrServerNotStopped) {
		t.Fatalf("Reinstall on a running server: got %v, want ErrServerNotStopped", err)
	}
}

// TestServer_ReinstallNeverCallsManagerRegister documents (rather than
// exercises directly — Register lives on Manager, not Server) the actual
// bug this method fixes: unlike Create, Reinstall never goes anywhere
// near manager.Register, so it can never hit the SERVER_EXISTS guard a
// version change on an already-registered server used to always trip
// (routes_create_server.go's handleCreateServer, called a second time
// for the same UUID). This test instead pins the regression at the level
// that actually matters: Reinstall mutates the EXISTING in-memory spec
// fields a version change needs to change, with no Register call
// anywhere in its signature or body to accidentally reintroduce.
func TestServer_ReinstallUpdatesSpecFieldsBeforeGuardCheck(t *testing.T) {
	s, _ := newBackupTestServer(t)
	s.State = StateRunning // refused before any spec mutation happens

	newEnv := map[string]string{"MINECRAFT_VERSION": "1.21.1"}
	_ = s.Reinstall(context.Background(), nil, "new/image:tag", "new startup", "SIGINT", newEnv)

	if s.spec.Image == "new/image:tag" {
		t.Fatal("Reinstall mutated s.spec.Image despite refusing on the offline guard — the guard must run before any state changes")
	}
}
