// Package fsx is the agent's filesystem jail (architecture doc 4.4): every
// customer file operation — list, read, write, rename, delete, chmod,
// archive — is resolved strictly beneath one server's own data directory,
// with the kernel itself as the enforcement point on Linux.
//
// A lexical sanitizer alone (reject "..", reject absolute paths) is not
// enough: it only protects the path string at the instant it's checked,
// and a symlink can be swapped in between that check and the actual
// open() (classic TOCTOU). Real production nodes close that window with
// openat2's RESOLVE_BENEATH flag (jail_linux.go) — the kernel refuses to
// resolve the final path if it would leave the starting directory, even
// through a symlink race, full stop. sanitize() below still runs first,
// but only so a rejected request gets a clean error instead of an opaque
// kernel errno; it is never the actual security boundary.
package fsx

import (
	"errors"
	"os"
	"path"
	"strings"
	"unicode/utf8"
)

var (
	// ErrInvalidPath is returned for anything sanitize() rejects lexically.
	ErrInvalidPath = errors.New("fsx: invalid path")
	// ErrEscapesJail is returned when the kernel (or, on the non-Linux
	// dev fallback, a lexical re-check) refuses a resolution that would
	// leave the jail root.
	ErrEscapesJail = errors.New("fsx: path escapes jail root")
	// ErrSymlink is returned for an archive entry that is a symlink or
	// hardlink — architecture doc 4.4: these are skipped and reported,
	// never followed, during extraction.
	ErrSymlink = errors.New("fsx: symlink/hardlink entries are not extracted")
)

const (
	maxPathBytes      = 4096
	maxComponentBytes = 255
)

// Open-mode flags, translated to platform-specific syscall flags inside
// each build's openRelative. Kept as our own small set (not os.O_* or
// syscall.O_*) so ops.go stays platform-agnostic.
type openFlag int

const (
	flagRead openFlag = 1 << iota
	flagWrite
	flagCreate
	flagExcl // with flagCreate: fail if it already exists (used by Mkdir's file-vs-dir collision check)
	flagTrunc
	flagDir
	flagNofollow // never follow a symlink for the FINAL path component (defense-in-depth on top of RESOLVE_BENEATH)
)

// Jail resolves every operation for one server strictly beneath root.
// Opened once per server (at registration) and closed once (at
// unregistration) — see architecture doc 4.4 ("opened once at server
// registration").
type Jail struct {
	root string
	fd   int // O_PATH|O_DIRECTORY dirfd on Linux; unused (-1) on the dev fallback
}

// Open opens the jail root. root must already exist.
func Open(root string) (*Jail, error) {
	fd, err := openJailRoot(root)
	if err != nil {
		return nil, err
	}
	return &Jail{root: root, fd: fd}, nil
}

func (j *Jail) Close() error {
	return closeJailRoot(j.fd)
}

func (j *Jail) Root() string { return j.root }

// sanitize is lexical-only (see package doc). Architecture doc 4.4 is
// explicit that a ".." component must be REJECTED, not silently
// reinterpreted — which is why the ".." check below runs on the RAW
// input, before path.Clean ever touches it. path.Clean on its own would
// be the wrong tool for this: for a rooted path it silently ABSORBS a
// leading ".." into the root ("/../etc" -> "/etc") rather than erroring,
// per its own documented behavior — relying on that alone would turn a
// request for "../../etc/passwd" into a silently-succeeding request for
// "etc/passwd" instead of the clean rejection the doc calls for. Found
// by this package's own test: a first version of sanitize() ran Clean
// first and treated the post-Clean absence of ".." as proof none were
// ever present, which is exactly backwards.
func sanitize(relPath string) (string, error) {
	if relPath == "" {
		return ".", nil
	}
	if !utf8.ValidString(relPath) || strings.ContainsRune(relPath, 0) {
		return "", ErrInvalidPath
	}
	if len(relPath) > maxPathBytes {
		return "", ErrInvalidPath
	}
	for _, comp := range strings.Split(relPath, "/") {
		if comp == ".." {
			return "", ErrInvalidPath
		}
	}
	clean := strings.TrimPrefix(path.Clean("/"+relPath), "/")
	if clean == "" || clean == "." {
		return ".", nil
	}
	for _, comp := range strings.Split(clean, "/") {
		if comp == "" || comp == "." {
			return "", ErrInvalidPath
		}
		if len(comp) > maxComponentBytes {
			return "", ErrInvalidPath
		}
	}
	return clean, nil
}

// resolve sanitizes relPath, then hands it to the platform-specific
// kernel resolver. A single openat2 call resolves an entire multi-
// component relative path ("a/b/c.txt") against the jail root in one
// step — RESOLVE_BENEATH applies to the WHOLE resolution, so there is no
// need to walk and re-open one directory level at a time.
func (j *Jail) resolve(relPath string, flags openFlag, mode uint32) (*os.File, error) {
	clean, err := sanitize(relPath)
	if err != nil {
		return nil, err
	}
	return j.openRelative(clean, flags, mode)
}
