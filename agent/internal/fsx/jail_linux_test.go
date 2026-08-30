//go:build linux

package fsx

import (
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
)

// TestJail_SymlinkSwapRaceNeverEscapes is architecture doc 4.4's
// "1000-iteration parallel symlink-swap race test": one goroutine
// continuously replaces a path component inside the jail with a symlink
// pointing OUTSIDE it, while several reader goroutines hammer the exact
// same relative path through the jail. openat2's RESOLVE_BENEATH is a
// kernel-enforced guarantee, not a probabilistic one — this test exists
// to catch a bug in OUR wiring of it (wrong flags, wrong dirfd, a
// resolve() path that bypasses openRelative) under real concurrent load,
// not to catch flakiness in the kernel itself.
//
// If this test ever reads the outside secret's content even once, the
// jail is broken.
func TestJail_SymlinkSwapRaceNeverEscapes(t *testing.T) {
	jailRoot := t.TempDir()
	outsideRoot := t.TempDir()

	outsideSecret := filepath.Join(outsideRoot, "secret.txt")
	if err := os.WriteFile(outsideSecret, []byte("OUTSIDE-SECRET"), 0o600); err != nil {
		t.Fatalf("seed outside secret: %v", err)
	}

	j, err := Open(jailRoot)
	if err != nil {
		t.Fatalf("Open jail: %v", err)
	}
	defer j.Close()

	linkPath := filepath.Join(jailRoot, "link")

	var escaped atomic.Bool
	var stop atomic.Bool
	var togglerDone sync.WaitGroup
	var readersWG sync.WaitGroup

	// Toggler: rapidly alternates "link" between a real directory
	// (containing probe.txt with INSIDE content) and a symlink pointing
	// at outsideRoot.
	togglerDone.Add(1)
	go func() {
		defer togglerDone.Done()
		for i := 0; !stop.Load(); i++ {
			_ = os.RemoveAll(linkPath)
			if i%2 == 0 {
				if err := os.Mkdir(linkPath, 0o750); err == nil {
					_ = os.WriteFile(filepath.Join(linkPath, "probe.txt"), []byte("INSIDE"), 0o600)
				}
			} else {
				_ = os.Symlink(outsideRoot, linkPath)
			}
		}
	}()

	// Readers: hammer the SAME relative path through the jail, exactly
	// as a real file-manager request would.
	const readers = 8
	const iterationsPerReader = 1000
	for r := 0; r < readers; r++ {
		readersWG.Add(1)
		go func() {
			defer readersWG.Done()
			for i := 0; i < iterationsPerReader; i++ {
				func() {
					f, err := j.Open("link/probe.txt")
					if err != nil {
						return // either "link" is currently the symlink (probe.txt doesn't exist there) or mid-toggle — both fine
					}
					defer f.Close()
					data, _ := io.ReadAll(f)
					// The toggler's own Mkdir-then-WriteFile is NOT atomic,
					// so a reader can legitimately win a benign race and
					// see the freshly created probe.txt before its content
					// is written — that's a timing artifact of this TEST's
					// setup, not a jail escape, so only a genuinely WRONG
					// non-empty content counts as a finding here.
					if len(data) > 0 && string(data) != "INSIDE" {
						if escaped.CompareAndSwap(false, true) {
							real, _ := os.Readlink("/proc/self/fd/" + strconv.Itoa(int(f.Fd())))
							t.Logf("MISMATCH probe.txt: got %q, real fd target=%q", data, real)
						}
					}
				}()
				func() {
					// Also try the outside file's own name directly — if
					// RESOLVE_BENEATH ever let the symlink resolve, THIS
					// is the read that would return the secret.
					f, err := j.Open("link/secret.txt")
					if err != nil {
						return
					}
					defer f.Close()
					data, _ := io.ReadAll(f)
					if string(data) == "OUTSIDE-SECRET" {
						if escaped.CompareAndSwap(false, true) {
							real, _ := os.Readlink("/proc/self/fd/" + strconv.Itoa(int(f.Fd())))
							t.Logf("MISMATCH secret.txt: got %q, real fd target=%q", data, real)
						}
					}
				}()
			}
		}()
	}

	readersWG.Wait()   // readers finish their fixed iteration counts...
	stop.Store(true)   // ...then tell the toggler to stop...
	togglerDone.Wait() // ...and wait for it to actually exit before TempDir cleanup runs.

	if escaped.Load() {
		t.Fatal("JAIL ESCAPE: a read through the jail returned content from outside the jail root")
	}
}
