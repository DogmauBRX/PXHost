package api

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/gxhost/agent/internal/spec"
)

// removeServerDataDir is the fix for a real production leak: 33 abandoned
// world directories found on one node (7.4GB, 95% of that node's
// server-directory disk usage) — handleDeleteServer removed the
// container and the panel row but never the data directory, because
// srv.Server.Remove's own doc comment says on-disk deletion was
// deliberately deferred to "a later milestone" that never landed. These
// exercise the filesystem side directly, without a live Docker daemon,
// matching this package's existing no-daemon-needed test pattern
// (orphan_test.go).
func TestRemoveServerDataDir(t *testing.T) {
	dataDir := t.TempDir()
	s := &Server{node: spec.Node{DataDir: dataDir}, log: slog.Default()}

	uuid := "11111111-1111-1111-1111-111111111111"
	live := filepath.Join(dataDir, uuid)
	if err := os.MkdirAll(filepath.Join(live, "world"), 0o755); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if err := os.WriteFile(filepath.Join(live, "world", "level.dat"), []byte("x"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}

	s.removeServerDataDir(uuid)

	if _, err := os.Stat(live); !os.IsNotExist(err) {
		t.Fatalf("server data directory still exists after delete: %v", err)
	}
}

// The exact 7252cf70 / f78c8aa8 shape found live: a server deleted while
// its last modpack install (or backup restore) still had an "-old"
// sibling waiting on the 1-hour delayed cleanup goroutine — a goroutine
// that only fires if the agent process is still the SAME one that
// started it. Deleting the server must not leave that sibling behind
// with nothing left to ever sweep it.
func TestRemoveServerDataDirSweepsSwapLeftoverSiblings(t *testing.T) {
	dataDir := t.TempDir()
	s := &Server{node: spec.Node{DataDir: dataDir}, log: slog.Default()}

	uuid := "22222222-2222-2222-2222-222222222222"
	for _, suffix := range []string{"", ".modpack-old", ".restore-old"} {
		if err := os.MkdirAll(filepath.Join(dataDir, uuid+suffix), 0o755); err != nil {
			t.Fatalf("setup %q: %v", suffix, err)
		}
	}

	s.removeServerDataDir(uuid)

	for _, suffix := range []string{"", ".modpack-old", ".restore-old"} {
		p := filepath.Join(dataDir, uuid+suffix)
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%q still exists after delete", p)
		}
	}
}

// A server that was never actually created (e.g. install failed before
// Register ever ran, so removeUnregisteredContainer's "not found" path is
// hit) has no data directory at all. RemoveAll on a nonexistent path is a
// documented no-op — this pins that down rather than assuming it, since
// the whole point of this function is to never turn a successful delete
// into a failed one.
func TestRemoveServerDataDirNonexistentIsNoop(t *testing.T) {
	dataDir := t.TempDir()
	s := &Server{node: spec.Node{DataDir: dataDir}, log: slog.Default()}
	s.removeServerDataDir("33333333-3333-3333-3333-333333333333") // must not panic or log a fatal path
}
