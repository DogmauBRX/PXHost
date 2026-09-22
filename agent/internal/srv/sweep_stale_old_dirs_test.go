package srv

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The leak this closes: modpack.go/backup.go schedule their own cleanup
// of a "<uuid>.modpack-old" / "<uuid>.restore-old" directory a full hour
// later via `go func() { time.Sleep(time.Hour); ... }()` — a goroutine
// that does not survive an agent restart. Found live: leftovers still on
// disk from restarts hours earlier, one holding ~390MB. SweepStaleOldDirs
// is meant to run once at boot and catch exactly those.
//
// touch backdates an entry's mtime so it clears staleOldDirAge without a
// real sleep.
func touch(t *testing.T, path string, age time.Duration) {
	t.Helper()
	mtime := time.Now().Add(-age)
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatalf("os.Chtimes(%q): %v", path, err)
	}
}

func TestSweepStaleOldDirsRemovesLeftoverWithLiveSibling(t *testing.T) {
	dataDir := t.TempDir()
	live := filepath.Join(dataDir, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	old := live + ".modpack-old"
	mustMkdir(t, live)
	mustMkdir(t, old)
	touch(t, old, 2*staleOldDirAge)

	SweepStaleOldDirs(dataDir, slog.Default())

	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("stale leftover %q should have been removed", old)
	}
	if _, err := os.Stat(live); err != nil {
		t.Errorf("live sibling %q must be untouched: %v", live, err)
	}
}

// The safety rule that matters most: an "-old" directory with NO live
// sibling means the agent died mid-swap, between renaming the live
// directory away and renaming the new content in. In that state the
// "-old" directory IS the server's only remaining data — deleting it
// would be real, unrecoverable data loss, not cleanup.
func TestSweepStaleOldDirsNeverTouchesIncompleteSwap(t *testing.T) {
	dataDir := t.TempDir()
	orphanedOld := filepath.Join(dataDir, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.restore-old")
	mustMkdir(t, orphanedOld)
	touch(t, orphanedOld, 2*staleOldDirAge)

	SweepStaleOldDirs(dataDir, slog.Default())

	if _, err := os.Stat(orphanedOld); err != nil {
		t.Fatalf("directory with no live sibling must NEVER be removed (would destroy the only copy of server data): %v", err)
	}
}

// Mirrors the 1-hour delayed goroutine's own intent: a directory young
// enough that its OWN cleanup goroutine (from THIS same agent lifetime)
// might still fire later must not be raced by the boot sweep.
func TestSweepStaleOldDirsSkipsYoungLeftover(t *testing.T) {
	dataDir := t.TempDir()
	live := filepath.Join(dataDir, "cccccccc-cccc-cccc-cccc-cccccccccccc")
	young := live + ".modpack-old"
	mustMkdir(t, live)
	mustMkdir(t, young)
	touch(t, young, staleOldDirAge/2)

	SweepStaleOldDirs(dataDir, slog.Default())

	if _, err := os.Stat(young); err != nil {
		t.Errorf("young leftover %q should not have been removed yet: %v", young, err)
	}
}

func TestSweepStaleOldDirsIgnoresUnrelatedDirectories(t *testing.T) {
	dataDir := t.TempDir()
	live := filepath.Join(dataDir, "dddddddd-dddd-dddd-dddd-dddddddddddd")
	mustMkdir(t, live)
	touch(t, live, 2*staleOldDirAge)

	SweepStaleOldDirs(dataDir, slog.Default()) // must not panic or remove a normal live server directory

	if _, err := os.Stat(live); err != nil {
		t.Errorf("unrelated live directory must be untouched: %v", err)
	}
}

func TestSweepStaleOldDirsOnMissingDataDirDoesNotPanic(t *testing.T) {
	SweepStaleOldDirs(filepath.Join(t.TempDir(), "does-not-exist"), slog.Default())
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("os.MkdirAll(%q): %v", path, err)
	}
}
