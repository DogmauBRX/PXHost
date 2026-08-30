package srv

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"time"

	"github.com/pxhost/agent/internal/backup"
	"github.com/pxhost/agent/internal/fsx"
)

// ErrServerNotStopped is returned by Restore when the server isn't
// currently offline — a distinct sentinel so callers (the HTTP layer)
// can map it to 409 Conflict rather than a generic 500.
var ErrServerNotStopped = errors.New("srv: server must be stopped before restore")

// restoreGraceWindow is how long the pre-restore data directory is kept
// (renamed aside, not deleted) before background cleanup — architecture
// doc 4.5: "the old directory is kept for a grace window ... so a bad
// restore is recoverable." Not configurable in M8; a fixed, generous
// window is simpler and safer than a per-request override that could be
// set to zero by mistake.
const restoreGraceWindow = 1 * time.Hour

// Backup streams the server's current files into a new archive via
// provider. Unlike Restore, this does NOT require the server to be
// stopped — a running server's files are still a coherent (if
// point-in-time-inconsistent for actively-written files) snapshot, and
// forcing a stop for every backup would make scheduled backups
// (architecture doc, later milestone) unacceptably disruptive.
func (s *Server) Backup(ctx context.Context, provider backup.Provider, ignore *backup.IgnoreSet) (backup.Backup, error) {
	return provider.Create(ctx, s.UUID, s.Jail, ignore)
}

// Restore extracts backupID into a fresh staging directory, validates it
// fully (provider.Restore's own two-pass dry-run), then atomically swaps
// it in for the server's live data directory — architecture doc 4.5:
// "extraction into a sibling staging directory, then an atomic rename(2)
// swap ... the old directory is kept for a grace window."
//
// Requires the server to already be stopped: restoring into a directory
// a running container has bind-mounted out from under it would leave
// the container's own view of the filesystem in an undefined state no
// atomic rename on the HOST side can fix.
func (s *Server) Restore(ctx context.Context, provider backup.Provider, backupID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.State != StateOffline {
		return fmt.Errorf("%w (current state: %s)", ErrServerNotStopped, s.State)
	}

	dataDir := path.Join(s.node.DataDir, s.UUID)
	stagingDir := dataDir + ".restore-staging"
	oldDir := dataDir + ".restore-old"
	_ = os.RemoveAll(stagingDir) // leftovers from a previous failed/interrupted attempt
	_ = os.RemoveAll(oldDir)

	if err := os.MkdirAll(stagingDir, 0o750); err != nil {
		return fmt.Errorf("srv: preparing restore staging dir: %w", err)
	}
	stagingJail, err := fsx.Open(stagingDir)
	if err != nil {
		_ = os.RemoveAll(stagingDir)
		return fmt.Errorf("srv: opening staging jail: %w", err)
	}

	if err := provider.Restore(ctx, s.UUID, backupID, stagingJail, s.spec.UID); err != nil {
		_ = stagingJail.Close()
		_ = os.RemoveAll(stagingDir)
		return fmt.Errorf("srv: restoring backup: %w", err)
	}
	_ = stagingJail.Close() // must close before rename: an open O_PATH fd doesn't block a rename, but there's no reason to hold it past this point

	// The live Jail's O_PATH fd is bound to the CURRENT directory's inode
	// — a rename doesn't invalidate it, but it also doesn't follow the
	// swap: closing and reopening against the (now-restored) path is
	// what makes every SUBSEQUENT file operation see the new content.
	if err := s.Jail.Close(); err != nil {
		return fmt.Errorf("srv: closing pre-restore jail: %w", err)
	}
	if err := os.Rename(dataDir, oldDir); err != nil {
		return fmt.Errorf("srv: swapping in restored data (moving old aside): %w", err)
	}
	if err := os.Rename(stagingDir, dataDir); err != nil {
		_ = os.Rename(oldDir, dataDir) // best-effort revert so the server isn't left with NO data dir at all
		return fmt.Errorf("srv: swapping in restored data (moving new into place): %w", err)
	}

	newJail, err := fsx.Open(dataDir)
	if err != nil {
		return fmt.Errorf("srv: reopening jail after restore: %w", err)
	}
	s.Jail = newJail

	go func() {
		time.Sleep(restoreGraceWindow)
		_ = os.RemoveAll(oldDir)
	}()
	return nil
}
