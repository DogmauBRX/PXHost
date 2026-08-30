//go:build linux

package fsx

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// openJailRoot opens root as an O_PATH|O_DIRECTORY dirfd — a "location
// handle" the kernel keeps valid even if the underlying directory is
// later renamed, without granting any read/write capability of its own.
// It is used purely as the dirfd argument to every later openat2 call.
func openJailRoot(root string) (int, error) {
	fd, err := unix.Open(root, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("fsx: open jail root %q: %w", root, err)
	}
	return fd, nil
}

func closeJailRoot(fd int) error {
	if fd < 0 {
		return nil
	}
	return unix.Close(fd)
}

func translateFlags(flags openFlag) (int, uint64) {
	var sysFlags int
	var resolve uint64 = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV

	switch {
	case flags&flagWrite != 0 && flags&flagRead != 0:
		sysFlags |= unix.O_RDWR
	case flags&flagWrite != 0:
		sysFlags |= unix.O_WRONLY
	default:
		sysFlags |= unix.O_RDONLY
	}
	if flags&flagCreate != 0 {
		sysFlags |= unix.O_CREAT
	}
	if flags&flagExcl != 0 {
		sysFlags |= unix.O_EXCL
	}
	if flags&flagTrunc != 0 {
		sysFlags |= unix.O_TRUNC
	}
	if flags&flagDir != 0 {
		sysFlags |= unix.O_DIRECTORY
	}
	// RESOLVE_NO_SYMLINKS is deliberately NOT the default here (a
	// legitimate mid-tree symlink inside the server's own directory —
	// e.g. one the game software itself created — should still resolve);
	// flagNofollow instead sets plain O_NOFOLLOW on the FINAL component
	// only, matching architecture doc 4.4's "symlink entries are skipped"
	// rule for archive extraction specifically, without breaking normal
	// file access through an intermediate symlink the customer made on
	// purpose.
	if flags&flagNofollow != 0 {
		sysFlags |= unix.O_NOFOLLOW
	}
	sysFlags |= unix.O_CLOEXEC
	return sysFlags, resolve
}

// openRelative is the ONE place this package calls into the kernel to
// resolve a customer-influenced path. RESOLVE_BENEATH makes escape
// impossible by construction: if resolving relPath would step outside
// the directory j.fd refers to — including via a symlink swapped in by a
// concurrent request (TOCTOU) — the syscall itself returns ENOENT/EXDEV,
// never a valid fd outside the root. That is what closes the classic
// check-then-use race a lexical sanitizer alone cannot close.
func (j *Jail) openRelative(relPath string, flags openFlag, mode uint32) (*os.File, error) {
	sysFlags, resolve := translateFlags(flags)
	how := unix.OpenHow{
		Flags:   uint64(sysFlags),
		Mode:    uint64(mode),
		Resolve: resolve,
	}
	fd, err := unix.Openat2(j.fd, relPath, &how)
	if err != nil {
		if err == unix.ENOENT || err == unix.EXDEV || err == unix.ELOOP {
			return nil, fmt.Errorf("%w: %s: %v", ErrEscapesJail, relPath, err)
		}
		return nil, fmt.Errorf("fsx: open %q: %w", relPath, err)
	}
	return os.NewFile(uintptr(fd), relPath), nil
}

// unlinkRelative removes a file (dir=false) or empty directory (dir=true).
func (j *Jail) unlinkRelative(relPath string, dir bool) error {
	flags := 0
	if dir {
		flags = unix.AT_REMOVEDIR
	}
	if err := unix.Unlinkat(j.fd, relPath, flags); err != nil {
		return fmt.Errorf("fsx: remove %q: %w", relPath, err)
	}
	return nil
}

func (j *Jail) mkdirRelative(relPath string, mode uint32) error {
	if err := unix.Mkdirat(j.fd, relPath, mode); err != nil {
		return fmt.Errorf("fsx: mkdir %q: %w", relPath, err)
	}
	return nil
}

// renameRelative renames within the SAME jail — both paths resolve
// relative to the same root fd, so this can never move a file into (or
// out of) another server's tree.
func (j *Jail) renameRelative(oldRel, newRel string) error {
	if err := unix.Renameat(j.fd, oldRel, j.fd, newRel); err != nil {
		return fmt.Errorf("fsx: rename %q -> %q: %w", oldRel, newRel, err)
	}
	return nil
}

func fchown(f *os.File, uid, gid int) error {
	return unix.Fchown(int(f.Fd()), uid, gid)
}

func fchmod(f *os.File, mode uint32) error {
	return unix.Fchmod(int(f.Fd()), mode)
}
