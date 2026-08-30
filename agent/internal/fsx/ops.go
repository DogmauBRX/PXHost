package fsx

import (
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"time"
)

const defaultCreateMode = 0o644
const defaultDirMode = 0o750

// Entry is one directory listing row.
type Entry struct {
	Name    string    `json:"name"`
	IsDir   bool      `json:"isDir"`
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"` // e.g. "-rw-r--r--"
	ModTime time.Time `json:"modTime"`
}

// List returns the contents of relPath (a directory), sorted directories
// first, then alphabetically — the ordering a file manager UI wants
// without re-sorting itself.
//
// Deliberately uses Readdirnames + our own jail-resolved Stat per entry,
// NOT os.File.ReadDir's fs.DirEntry.Info() — found live (only reproduces
// on real Linux, via openat2): DirEntry.Info() stats an entry by
// constructing "<fd's reported name>/<entry>" and calling plain Lstat,
// which resolves relative to the PROCESS's cwd, not to the directory the
// fd actually points at. Since a jail-resolved fd's reported name is a
// relative, jail-scoped string like "." (openRelative names it after the
// resolved path, not a real filesystem path), every single entry's
// Info() failed with ENOENT and was silently skipped — sanitize()/
// openat2 were never at fault, but the effect was that List() always
// returned zero rows.
func (j *Jail) List(relPath string) ([]Entry, error) {
	clean, err := sanitize(relPath)
	if err != nil {
		return nil, err
	}
	dir, err := j.openRelative(clean, flagDir, 0)
	if err != nil {
		return nil, err
	}
	defer dir.Close()

	names, err := dir.Readdirnames(-1)
	if err != nil {
		return nil, fmt.Errorf("fsx: list %q: %w", relPath, err)
	}

	entries := make([]Entry, 0, len(names))
	for _, name := range names {
		info, err := j.stat(path.Join(clean, name))
		if err != nil {
			continue // vanished between readdir and stat (deleted concurrently) — just skip it
		}
		entries = append(entries, Entry{
			Name:    name,
			IsDir:   info.IsDir(),
			Size:    info.Size(),
			Mode:    info.Mode().String(),
			ModTime: info.ModTime(),
		})
	}
	sort.Slice(entries, func(i, k int) bool {
		if entries[i].IsDir != entries[k].IsDir {
			return entries[i].IsDir
		}
		return entries[i].Name < entries[k].Name
	})
	return entries, nil
}

// Open opens relPath for reading. The caller is responsible for closing
// it; used both for direct read APIs and for streaming a download.
func (j *Jail) Open(relPath string) (*os.File, error) {
	return j.resolve(relPath, flagRead, 0)
}

// MaxEditableFileBytes bounds what the in-browser text editor will ever
// return — large binary/log files still need a download link, not an
// inline edit view.
const MaxEditableFileBytes = 2 << 20 // 2 MiB

// ReadFile returns the full contents of relPath, capped at
// MaxEditableFileBytes.
func (j *Jail) ReadFile(relPath string) ([]byte, error) {
	f, err := j.Open(relPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if stat.IsDir() {
		return nil, fmt.Errorf("fsx: %q is a directory", relPath)
	}
	if stat.Size() > MaxEditableFileBytes {
		return nil, fmt.Errorf("fsx: %q is %d bytes, exceeds the %d byte inline-edit limit", relPath, stat.Size(), MaxEditableFileBytes)
	}
	return io.ReadAll(io.LimitReader(f, MaxEditableFileBytes+1))
}

// WriteFile writes the full contents of r to relPath, creating it if
// necessary. Ownership dance (architecture doc 4.4): open 0600, chown to
// the server's uid BEFORE any byte is written — the short window between
// create and chown contains only an empty, unreadable-by-others file —
// then set the real final mode once writing succeeds.
func (j *Jail) WriteFile(relPath string, r io.Reader, uid int, maxBytes int64) (int64, error) {
	f, err := j.resolve(relPath, flagWrite|flagCreate|flagTrunc, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	if err := fchown(f, uid, uid); err != nil {
		return 0, fmt.Errorf("fsx: chown %q: %w", relPath, err)
	}

	limited := io.LimitReader(r, maxBytes+1)
	n, err := io.Copy(f, limited)
	if err != nil {
		return n, fmt.Errorf("fsx: write %q: %w", relPath, err)
	}
	if n > maxBytes {
		return n, fmt.Errorf("fsx: write %q: exceeds %d byte limit", relPath, maxBytes)
	}
	if err := fchmod(f, defaultCreateMode); err != nil {
		return n, fmt.Errorf("fsx: chmod %q: %w", relPath, err)
	}
	return n, nil
}

// MkdirAll creates relPath and every missing ancestor, each individually
// jail-resolved (used by both archive extraction and backup restore —
// see mkdirAllRelative in archive.go for why a per-level check-then-
// create loop here is still safe: every create still goes through
// openat2, so a symlink swapped in mid-walk fails the SAME way a direct
// request for that path would).
func (j *Jail) MkdirAll(relPath string, uid int) error {
	return j.mkdirAllRelative(relPath, defaultDirMode, uid)
}

// Mkdir creates relPath as a directory, chowned to uid.
func (j *Jail) Mkdir(relPath string, uid int) error {
	clean, err := sanitize(relPath)
	if err != nil {
		return err
	}
	if err := j.mkdirRelative(clean, defaultDirMode); err != nil {
		return err
	}
	dir, err := j.resolve(relPath, flagDir, 0)
	if err != nil {
		return err
	}
	defer dir.Close()
	return fchown(dir, uid, uid)
}

// Remove deletes a file or, if recursive is true, a directory and
// everything under it. Non-recursive directory delete fails if it isn't
// empty (matches the panel's own "empty the trash first" UX rather than
// silently doing a recursive delete on a plain "delete" click).
func (j *Jail) Remove(relPath string, recursive bool) error {
	clean, err := sanitize(relPath)
	if err != nil {
		return err
	}
	info, err := j.stat(clean)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return j.unlinkRelative(clean, false)
	}
	if !recursive {
		return j.unlinkRelative(clean, true) // fails with ENOTEMPTY if non-empty, which is exactly the desired behavior
	}
	entries, err := j.List(clean)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := j.Remove(path.Join(clean, e.Name), true); err != nil {
			return err
		}
	}
	return j.unlinkRelative(clean, true)
}

// Rename moves oldRel to newRel, both resolved within the same jail.
func (j *Jail) Rename(oldRel, newRel string) error {
	oldClean, err := sanitize(oldRel)
	if err != nil {
		return err
	}
	newClean, err := sanitize(newRel)
	if err != nil {
		return err
	}
	return j.renameRelative(oldClean, newClean)
}

// Chmod sets relPath's mode bits (masked to the standard rwx bits — the
// panel never gets to set setuid/setgid/sticky, architecture doc 4.4's
// same rule for archive extraction applies to a direct chmod request).
func (j *Jail) Chmod(relPath string, mode uint32) error {
	f, err := j.resolve(relPath, flagRead, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return fchmod(f, mode&0o777)
}

func (j *Jail) stat(cleanRelPath string) (os.FileInfo, error) {
	f, err := j.openRelative(cleanRelPath, flagRead, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Stat()
}

// Stat is the exported form of stat, for callers (e.g. the download
// signed-URL handler) that need size/mode without opening for a full read.
func (j *Jail) Stat(relPath string) (os.FileInfo, error) {
	clean, err := sanitize(relPath)
	if err != nil {
		return nil, err
	}
	return j.stat(clean)
}
