package fsx

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
)

const (
	// Zip's central directory gives every entry's compressed/uncompressed
	// size UP FRONT, before extracting anything — unlike a streaming
	// tar.gz, a whole archive can be bounds-checked before a single byte
	// is written. io.LimitedReader below is still used as a backstop
	// against a header that lies about its own size.
	maxArchiveEntries          = 100_000
	maxArchiveTotalUncompBytes = 10 << 30 // 10 GiB hard ceiling, independent of plan quota (checked separately)
	ratioCheckThresholdBytes   = 1 << 20  // architecture doc 4.4: ratio is only "evaluated continuously past 1 MiB" — a small file compressing very well is not a bomb
	maxCompressionRatio        = 1000
)

// ErrArchiveBomb covers entry-count, total-size, and per-entry
// compression-ratio limits — three independent caps, as architecture doc
// 4.4 requires.
var ErrArchiveBomb = errors.New("fsx: archive rejected (bomb protection)")

// Decompress extracts the zip archive at srcRel into destRel (a directory,
// created if missing). Every entry name is jail-resolved before being
// written — a "../../etc/passwd" entry name fails the SAME openat2
// resolution a browser-supplied file path would, not a special case.
// Symlink/hardlink/device entries are skipped and reported, never
// followed or created; setuid/setgid/sticky bits are stripped from every
// extracted mode.
func (j *Jail) Decompress(srcRel, destRel string, uid int) (extracted int, skipped []string, err error) {
	srcFile, err := j.Open(srcRel)
	if err != nil {
		return 0, nil, err
	}
	defer srcFile.Close()

	stat, err := srcFile.Stat()
	if err != nil {
		return 0, nil, err
	}
	zr, err := zip.NewReader(srcFile, stat.Size())
	if err != nil {
		return 0, nil, fmt.Errorf("fsx: open archive %q: %w", srcRel, err)
	}

	if len(zr.File) > maxArchiveEntries {
		return 0, nil, fmt.Errorf("%w: %d entries exceeds the %d entry limit", ErrArchiveBomb, len(zr.File), maxArchiveEntries)
	}

	var totalUncompressed int64
	for _, zf := range zr.File {
		totalUncompressed += int64(zf.UncompressedSize64)
		if totalUncompressed > maxArchiveTotalUncompBytes {
			return 0, nil, fmt.Errorf("%w: total uncompressed size exceeds %d bytes", ErrArchiveBomb, maxArchiveTotalUncompBytes)
		}
		if zf.UncompressedSize64 > ratioCheckThresholdBytes && zf.CompressedSize64 > 0 {
			ratio := float64(zf.UncompressedSize64) / float64(zf.CompressedSize64)
			if ratio > maxCompressionRatio {
				return 0, nil, fmt.Errorf("%w: entry %q has compression ratio %.0f:1", ErrArchiveBomb, zf.Name, ratio)
			}
		}
	}
	// Decompress doesn't know the server's plan disk limit (Jail carries
	// no plan data) — callers MUST call CheckQuota(totalUncompressed,
	// planLimitMb) themselves before invoking Decompress; the entry-count/
	// total-size/ratio checks above are the archive-bomb protections that
	// apply regardless of plan, on top of that.

	for _, zf := range zr.File {
		entryRel := path.Join(destRel, zf.Name)

		mode := zf.Mode()
		if mode&(os.ModeSymlink|os.ModeDevice|os.ModeNamedPipe|os.ModeSocket|os.ModeCharDevice) != 0 {
			skipped = append(skipped, zf.Name)
			continue
		}

		if zf.FileInfo().IsDir() {
			clean, serr := sanitize(entryRel)
			if serr != nil {
				return extracted, skipped, serr
			}
			// MkdirAll-equivalent: create every missing ancestor. Each
			// mkdirRelative call is itself jail-resolved (no ".." can
			// have survived sanitize), so a deeply nested entry can't
			// walk itself out through a symlink swapped in mid-loop —
			// the NEXT iteration's create still goes through openat2.
			_ = j.mkdirAllRelative(clean, defaultDirMode, uid)
			continue
		}

		if err := j.mkdirAllRelative(parentOf(entryRel), defaultDirMode, uid); err != nil {
			return extracted, skipped, err
		}

		rc, err := zf.Open()
		if err != nil {
			return extracted, skipped, fmt.Errorf("fsx: read entry %q: %w", zf.Name, err)
		}
		// Regular-bits only — architecture doc 4.4: setuid/setgid/sticky
		// are stripped from every extracted mode, unconditionally.
		safeMode := uint32(mode.Perm() & 0o777)
		if safeMode == 0 {
			safeMode = defaultCreateMode
		}
		n, werr := j.WriteFile(entryRel, io.LimitReader(rc, int64(zf.UncompressedSize64)+1), uid, int64(zf.UncompressedSize64)+1)
		rc.Close()
		if werr != nil {
			return extracted, skipped, fmt.Errorf("fsx: extract %q: %w", zf.Name, werr)
		}
		if uint64(n) != zf.UncompressedSize64 {
			return extracted, skipped, fmt.Errorf("%w: entry %q wrote %d bytes, header claimed %d", ErrArchiveBomb, zf.Name, n, zf.UncompressedSize64)
		}
		if err := j.Chmod(entryRel, safeMode); err != nil {
			return extracted, skipped, err
		}
		extracted++
	}
	return extracted, skipped, nil
}

// Compress writes a zip archive at destRel containing every path in
// relPaths (files or directories, recursed).
func (j *Jail) Compress(relPaths []string, destRel string, uid int) error {
	destFile, err := j.resolve(destRel, flagWrite|flagCreate|flagTrunc, 0o600)
	if err != nil {
		return err
	}
	defer destFile.Close()
	if err := fchown(destFile, uid, uid); err != nil {
		return err
	}

	zw := zip.NewWriter(destFile)
	for _, rel := range relPaths {
		if err := j.addToZip(zw, rel); err != nil {
			_ = zw.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("fsx: finalize archive: %w", err)
	}
	return fchmod(destFile, defaultCreateMode)
}

func (j *Jail) addToZip(zw *zip.Writer, rel string) error {
	info, err := j.Stat(rel)
	if err != nil {
		return err
	}
	if info.IsDir() {
		entries, err := j.List(rel)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := j.addToZip(zw, path.Join(rel, e.Name)); err != nil {
				return err
			}
		}
		return nil
	}

	f, err := j.Open(rel)
	if err != nil {
		return err
	}
	defer f.Close()

	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	header.Name = rel
	header.Method = zip.Deflate
	w, err := zw.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, f)
	return err
}

// mkdirAllRelative creates relPath and every missing ancestor, each
// individually jail-resolved.
func (j *Jail) mkdirAllRelative(relPath string, mode uint32, uid int) error {
	clean, err := sanitize(relPath)
	if err != nil {
		return err
	}
	if clean == "." {
		return nil
	}
	if _, err := j.stat(clean); err == nil {
		return nil // already exists
	}
	if parent := parentOf(clean); parent != "." {
		if err := j.mkdirAllRelative(parent, mode, uid); err != nil {
			return err
		}
	}
	if err := j.mkdirRelative(clean, mode); err != nil {
		if os.IsExist(err) {
			return nil
		}
		return err
	}
	dir, err := j.openRelative(clean, flagDir, 0)
	if err != nil {
		return err
	}
	defer dir.Close()
	return fchown(dir, uid, uid)
}

func parentOf(relPath string) string {
	p := path.Dir(relPath)
	if p == "" {
		return "."
	}
	return p
}
