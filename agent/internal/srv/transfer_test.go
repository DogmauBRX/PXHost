package srv

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/pxhost/agent/internal/backup"
)

func TestServer_ExportRejectsWhenNotStopped(t *testing.T) {
	s, provider := newBackupTestServer(t)
	s.State = StateRunning // simulate a live server without a real container

	_, err := s.Export(context.Background(), provider)
	if !errors.Is(err, ErrServerNotStopped) {
		t.Fatalf("Export on a running server: got %v, want ErrServerNotStopped", err)
	}
}

func TestServer_ExportThenProviderPutRestoreRoundTrips(t *testing.T) {
	s, provider := newBackupTestServer(t)
	ctx := context.Background()

	if _, err := s.Jail.WriteFile("world.dat", strings.NewReader("transfer me"), s.UID(), 1000); err != nil {
		t.Fatalf("seed WriteFile: %v", err)
	}

	b, err := s.Export(ctx, provider) // s.State is StateOffline by default (New's zero value)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	// Simulate the target node: fetch bytes (here, just Open the same
	// archive the source just wrote) and Put them into a SEPARATE
	// provider instance under the same id, exactly like
	// fetchAndRestoreTransfer does with an HTTP response body.
	rc, _, err := provider.Open(ctx, s.UUID, b.ID)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer rc.Close()

	targetDir := t.TempDir()
	targetProvider := backup.NewLocalProvider(targetDir)
	if _, err := targetProvider.Put(ctx, s.UUID, b.ID, rc); err != nil {
		t.Fatalf("Put: %v", err)
	}

	dest, _ := newBackupTestServer(t)
	if err := targetProvider.Restore(ctx, s.UUID, b.ID, dest.Jail, dest.UID()); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	got, err := dest.Jail.ReadFile("world.dat")
	if err != nil {
		t.Fatalf("ReadFile on target: %v", err)
	}
	if string(got) != "transfer me" {
		t.Fatalf("target content = %q, want %q", got, "transfer me")
	}
}
