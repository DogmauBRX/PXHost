package srv

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/pxhost/agent/internal/backup"
	"github.com/pxhost/agent/internal/spec"
)

func newBackupTestServer(t *testing.T) (*Server, *backup.LocalProvider) {
	t.Helper()
	dataDir := t.TempDir()
	backupDir := t.TempDir()
	node := spec.Node{DataDir: dataDir, BackupDir: backupDir, UIDRangeMin: 1, UIDRangeMax: 999999}
	sv := spec.Server{UUID: "backup-test-server", UID: os.Getuid(), Limits: spec.Limits{MemoryMB: 512}}
	s, err := New(sv, node)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = s.Jail.Close() })
	return s, backup.NewLocalProvider(backupDir)
}

func TestServer_BackupThenRestoreSwapsInNewContent(t *testing.T) {
	s, provider := newBackupTestServer(t)
	ctx := context.Background()

	if _, err := s.Jail.WriteFile("world.dat", strings.NewReader("version 1"), s.UID(), 1000); err != nil {
		t.Fatalf("seed WriteFile: %v", err)
	}
	b, err := s.Backup(ctx, provider, nil)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}

	// Simulate further play after the backup: overwrite the file.
	if _, err := s.Jail.WriteFile("world.dat", strings.NewReader("version 2 (about to be reverted)"), s.UID(), 1000); err != nil {
		t.Fatalf("overwrite WriteFile: %v", err)
	}

	if err := s.Restore(ctx, provider, b.ID); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	got, err := s.Jail.ReadFile("world.dat")
	if err != nil {
		t.Fatalf("ReadFile after restore: %v", err)
	}
	if string(got) != "version 1" {
		t.Fatalf("post-restore content = %q, want %q (restore should have reverted the second write)", got, "version 1")
	}
}

func TestServer_RestoreRejectedWhileRunning(t *testing.T) {
	s, provider := newBackupTestServer(t)
	s.mu.Lock()
	s.State = StateRunning
	s.mu.Unlock()

	err := s.Restore(context.Background(), provider, "whatever-id")
	if err == nil {
		t.Fatal("expected Restore to refuse to run while the server is not offline")
	}
}

func TestServer_RestoreKeepsOldDataDirForGraceWindow(t *testing.T) {
	s, provider := newBackupTestServer(t)
	ctx := context.Background()

	if _, err := s.Jail.WriteFile("a.txt", strings.NewReader("original"), s.UID(), 100); err != nil {
		t.Fatalf("seed: %v", err)
	}
	b, err := s.Backup(ctx, provider, nil)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if _, err := s.Jail.WriteFile("b.txt", strings.NewReader("only in the pre-restore state"), s.UID(), 100); err != nil {
		t.Fatalf("seed2: %v", err)
	}

	dataDir := s.Jail.Root()
	if err := s.Restore(ctx, provider, b.ID); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	if _, err := os.Stat(dataDir + ".restore-old"); err != nil {
		t.Fatalf("expected the pre-restore directory to survive as a .restore-old sibling: %v", err)
	}
	if _, err := os.Stat(dataDir + ".restore-old/b.txt"); err != nil {
		t.Fatalf("expected b.txt to still exist in the kept-aside pre-restore directory: %v", err)
	}
}
