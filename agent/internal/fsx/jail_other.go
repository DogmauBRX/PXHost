//go:build !linux

package fsx

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// This build exists ONLY so the agent compiles and its HTTP-level
// plumbing (routes, signed URLs, panel wiring) can be exercised on a
// non-Linux dev machine (Windows + Docker Desktop, this project's own
// dev environment — see agent/README.md). It is explicitly NOT the
// security boundary: architecture doc 4.4 is unambiguous that the
// kernel-enforced openat2 path (jail_linux.go) is the only one ever
// shipped to a real node, and the doc's own words are "the string-based
// fallback is treated as dead code, not shipped as a real path." This
// file re-checks the resolved path lexically after joining — a real
// TOCTOU race (symlink swapped in between the check and the open) is NOT
// closed here, matching the doc's own precedent for dev-only exceptions
// (srv/install.go's chown is the same kind of carve-out).

func openJailRoot(root string) (int, error) {
	if _, err := os.Stat(root); err != nil {
		return -1, fmt.Errorf("fsx: jail root %q: %w", root, err)
	}
	return -1, nil
}

func closeJailRoot(int) error { return nil }

func (j *Jail) openRelative(relPath string, flags openFlag, mode uint32) (*os.File, error) {
	full := filepath.Join(j.root, filepath.FromSlash(relPath))
	// Re-derive relative-to-root and confirm it still starts with root —
	// lexical only, see file doc comment above.
	rel, err := filepath.Rel(j.root, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, ErrEscapesJail
	}

	sysFlags := os.O_RDONLY
	switch {
	case flags&flagWrite != 0 && flags&flagRead != 0:
		sysFlags = os.O_RDWR
	case flags&flagWrite != 0:
		sysFlags = os.O_WRONLY
	}
	if flags&flagCreate != 0 {
		sysFlags |= os.O_CREATE
	}
	if flags&flagExcl != 0 {
		sysFlags |= os.O_EXCL
	}
	if flags&flagTrunc != 0 {
		sysFlags |= os.O_TRUNC
	}

	if flags&flagDir != 0 {
		f, err := os.Open(full)
		if err != nil {
			return nil, fmt.Errorf("fsx: open %q: %w", relPath, err)
		}
		return f, nil
	}
	f, err := os.OpenFile(full, sysFlags, os.FileMode(mode))
	if err != nil {
		return nil, fmt.Errorf("fsx: open %q: %w", relPath, err)
	}
	return f, nil
}

func (j *Jail) unlinkRelative(relPath string, _ bool) error {
	full := filepath.Join(j.root, filepath.FromSlash(relPath))
	if err := os.Remove(full); err != nil {
		return fmt.Errorf("fsx: remove %q: %w", relPath, err)
	}
	return nil
}

func (j *Jail) mkdirRelative(relPath string, mode uint32) error {
	full := filepath.Join(j.root, filepath.FromSlash(relPath))
	if err := os.Mkdir(full, os.FileMode(mode)); err != nil {
		return fmt.Errorf("fsx: mkdir %q: %w", relPath, err)
	}
	return nil
}

func (j *Jail) renameRelative(oldRel, newRel string) error {
	oldFull := filepath.Join(j.root, filepath.FromSlash(oldRel))
	newFull := filepath.Join(j.root, filepath.FromSlash(newRel))
	if err := os.Rename(oldFull, newFull); err != nil {
		return fmt.Errorf("fsx: rename %q -> %q: %w", oldRel, newRel, err)
	}
	return nil
}

// fchown is best-effort/no-op on non-Linux, same precedent as
// srv/install.go's writeInstallScript: chown requires a POSIX uid/gid
// model this dev environment doesn't have.
func fchown(*os.File, int, int) error { return nil }

func fchmod(f *os.File, mode uint32) error {
	return f.Chmod(os.FileMode(mode))
}
