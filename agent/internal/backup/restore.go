package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"path"

	"github.com/pxhost/agent/internal/fsx"
)

// Tar has no upfront central directory the way zip does — sizes aren't
// known until each header is actually read — so these caps are the
// restore-side equivalent of fsx's archive-bomb protection, enforced
// while streaming through the WHOLE archive during validation, before
// extraction ever starts.
const (
	maxRestoreEntries    = 200_000
	maxRestoreTotalBytes = 50 << 30 // 50 GiB
)

// Restore validates the ENTIRE archive's headers (entry count, total
// declared size) in one streaming pass with zero bytes written, THEN —
// only if that pass completed cleanly — re-reads the archive from the
// start and actually extracts (architecture doc 4.5: "dry-run header
// validation before any byte is written"). dest must already be an
// empty, jail-opened staging directory; the caller does the atomic swap
// into the server's real data directory afterward.
func (p *LocalProvider) Restore(ctx context.Context, serverUUID, backupID string, dest *fsx.Jail, uid int) error {
	tarPath, err := p.backupPath(serverUUID, backupID)
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(tarPath); statErr != nil {
		if os.IsNotExist(statErr) {
			return ErrNotFound
		}
		return statErr
	}

	if err := validateRestoreArchive(tarPath); err != nil {
		return err
	}
	return extractRestoreArchive(ctx, tarPath, dest, uid)
}

func validateRestoreArchive(tarPath string) error {
	f, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidArchive, err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)

	var entries int
	var total int64
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidArchive, err)
		}
		entries++
		if entries > maxRestoreEntries {
			return fmt.Errorf("%w: more than %d entries", ErrArchiveTooLarge, maxRestoreEntries)
		}
		total += hdr.Size
		if total > maxRestoreTotalBytes {
			return fmt.Errorf("%w: more than %d bytes total", ErrArchiveTooLarge, maxRestoreTotalBytes)
		}
	}
}

// extractRestoreArchive re-reads tarPath from the start (validation
// above already consumed its own gzip.Reader) and writes every regular
// file/directory entry through dest's jail-resolved primitives — a
// "../../etc/cron.d/x" entry name fails the exact same openat2
// resolution a browser-supplied file path would. Symlink/hardlink/device
// entries are skipped, never followed or created, same posture as the
// file manager's zip extraction.
func extractRestoreArchive(ctx context.Context, tarPath string, dest *fsx.Jail, uid int) error {
	f, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidArchive, err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidArchive, err)
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := dest.MkdirAll(hdr.Name, uid); err != nil {
				return fmt.Errorf("backup: creating %q: %w", hdr.Name, err)
			}
		case tar.TypeReg:
			if err := dest.MkdirAll(path.Dir(hdr.Name), uid); err != nil {
				return fmt.Errorf("backup: preparing %q: %w", hdr.Name, err)
			}
			if _, err := dest.WriteFile(hdr.Name, io.LimitReader(tr, hdr.Size+1), uid, hdr.Size+1); err != nil {
				return fmt.Errorf("backup: extracting %q: %w", hdr.Name, err)
			}
		default:
			continue
		}
	}
}
