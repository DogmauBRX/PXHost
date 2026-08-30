package srv

import (
	"context"
	"errors"
	"testing"
)

// TestServer_StartRefusesWhenSuspended exercises the suspended check in
// isolation, before any real Docker call — the check runs first in
// Start(), so this needs no real container the way SetSuspended's own
// force-kill behavior would (see this package's other tests' notes on
// dockerFull being a concrete type with no fake-able seam; that half is
// proven live instead, not here).
func TestServer_StartRefusesWhenSuspended(t *testing.T) {
	s, _ := newBackupTestServer(t)
	s.ContainerID = "fake-container-id" // Start's first guard requires a container to exist
	s.spec.IsSuspended = true

	err := s.Start(context.Background(), nil)
	if !errors.Is(err, ErrServerSuspended) {
		t.Fatalf("Start on a suspended server: got %v, want ErrServerSuspended", err)
	}
}

func TestServer_SuspendedReportsCurrentFlag(t *testing.T) {
	s, _ := newBackupTestServer(t)
	if s.Suspended() {
		t.Fatal("a freshly created server should not report suspended")
	}
	s.spec.IsSuspended = true
	if !s.Suspended() {
		t.Fatal("Suspended() should reflect spec.IsSuspended")
	}
}
