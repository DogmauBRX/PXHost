//go:build linux

package srv

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/gxhost/agent/internal/spec"
)

// Restore's own staging directory root was never chowned to the server's
// sandboxed uid — only the ENTRIES a backup archive extracts into it
// were (provider.Restore's per-file dest.MkdirAll/dest.WriteFile calls),
// since a tar backup has no entry for its own "." root. The atomic
// rename swap (stagingDir -> live dataDir) never changes ownership, so
// the live directory came out of every restore owned by the AGENT,
// permanently — found live on a real server whose every install/start
// attempt failed with "Permission denied" cd'ing into its own data
// directory.
//
// Linux-only file: chown(2) semantics (an unprivileged process can never
// change a file's owner to a DIFFERENT uid, CAP_CHOWN or not — that's
// the man page's own rule) are what make the negative case below
// meaningful, and reading a file's owning uid back needs syscall.Stat_t,
// which doesn't exist on other platforms. This codebase's own comments
// already treat non-Linux as "chown was never going to work anyway"
// (server.go's New(), for the same reason).

func TestServer_RestoreFailsRatherThanSilentlyLeavingWrongOwnership(t *testing.T) {
	if os.Geteuid() == 0 {
		// Root can chown to any uid regardless of CAP_CHOWN nuances — this
		// negative case only means something for an UNPRIVILEGED process
		// (exactly how the real agent runs: uid 999 'gxhost' with a
		// curated capability set, never root). A root test runner (a
		// container's default user, some CI images) can't exercise it.
		t.Skip("requires running as a non-root user to exercise chown(2)'s own restriction")
	}
	s, provider := newBackupTestServer(t)
	ctx := context.Background()

	if _, err := s.Jail.WriteFile("a.txt", strings.NewReader("original"), s.UID(), 100); err != nil {
		t.Fatalf("seed: %v", err)
	}
	b, err := s.Backup(ctx, provider, nil)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}

	// An unprivileged test process can NEVER chown a path to a uid other
	// than its own, CAP_CHOWN or not — chown(2)'s own rule, not something
	// this test environment can route around. Before the fix, Restore
	// never even ATTEMPTED this chown, so it would have "succeeded" here
	// despite leaving the live directory permanently unreadable to
	// whatever uid the server was actually assigned.
	s.spec.UID = os.Getuid() + 1

	if err := s.Restore(ctx, provider, b.ID); err == nil {
		t.Fatal("Restore succeeded despite being unable to chown its own staging root to the server's uid — the exact silent corruption this fix closes")
	}

	// A failed attempt must not leave a half-swapped mess: the ORIGINAL
	// live directory (still correctly owned, from newBackupTestServer's
	// own New() call) has to still be there and untouched.
	if _, statErr := s.Jail.ReadFile("a.txt"); statErr != nil {
		t.Fatalf("original data directory should be untouched after a failed restore: %v", statErr)
	}
}

func TestServer_RestoreChownsStagingRootOnSuccess(t *testing.T) {
	s, provider := newBackupTestServer(t)
	ctx := context.Background()

	if _, err := s.Jail.WriteFile("a.txt", strings.NewReader("v1"), s.UID(), 10); err != nil {
		t.Fatalf("seed: %v", err)
	}
	b, err := s.Backup(ctx, provider, nil)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}

	if err := s.Restore(ctx, provider, b.ID); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	if uid := ownerUID(t, s.Jail.Root()); uid != s.UID() {
		t.Fatalf("live data directory root owned by uid %d after restore, want %d (the server's own uid)", uid, s.UID())
	}
}

// ReassertDataDirOwnership is the self-healing backstop for this same
// class of bug (any silent chown failure, not just Restore's fixed one):
// it re-chowns every registered server's data directory unconditionally,
// so a directory already wrong — however it got that way — is corrected
// without anyone restarting the agent AND noticing a "Permission denied"
// first.
func TestManager_ReassertDataDirOwnershipFixesWrongOwner(t *testing.T) {
	dataDir := t.TempDir()
	node := spec.Node{DataDir: dataDir}
	m := NewManager()
	sv := spec.Server{UUID: "reassert-test", UID: os.Getuid(), Limits: spec.Limits{MemoryMB: 512}}
	if _, err := m.Register(sv, node); err != nil {
		t.Fatalf("Register: %v", err)
	}

	live := filepath.Join(dataDir, "reassert-test")
	// New() already chowned this to os.Getuid() (a no-op — chowning to
	// yourself needs no privilege), so there's nothing to actually flip
	// here without root. This proves the call is SAFE and idempotent
	// against an already-correct directory instead: it must not error,
	// remove anything, or otherwise disturb it.
	if err := os.WriteFile(filepath.Join(live, "marker.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("seed marker: %v", err)
	}

	m.ReassertDataDirOwnership(slog.Default())

	if uid := ownerUID(t, live); uid != os.Getuid() {
		t.Fatalf("live data directory owned by uid %d after reassertion, want %d (unchanged)", uid, os.Getuid())
	}
	if _, err := os.Stat(filepath.Join(live, "marker.txt")); err != nil {
		t.Fatalf("marker file should survive ownership reassertion untouched: %v", err)
	}
}

func TestServer_InstallOwnershipCheckRejectsUnrepairableDataDir(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires an unprivileged process to exercise a failed chown")
	}

	dataDir := t.TempDir()
	node := spec.Node{DataDir: dataDir}
	sv := spec.Server{UUID: "install-owner-test", UID: os.Getuid(), Limits: spec.Limits{MemoryMB: 512}}
	s, err := New(sv, node)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Model a directory whose expected sandbox uid differs from its real
	// owner. The old install path ignored this state and only failed inside
	// Docker at `cd /mnt/server`; the preflight must surface it directly.
	s.spec.UID = os.Getuid() + 1
	if err := s.ensureDataDirOwnership(); err == nil {
		t.Fatal("ownership check succeeded despite being unable to chown the data directory")
	}
}

func ownerUID(t *testing.T, path string) int {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %q: %v", path, err)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatalf("could not read raw stat_t for %q", path)
	}
	return int(st.Uid)
}
