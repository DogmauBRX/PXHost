// Package backup implements server backups (architecture doc 4.5):
// streaming tar.gz creation with a sha256 checksum, ignore-pattern
// matching, and restore into a jail-safe staging directory that the
// caller (srv.Server.Restore) atomically swaps into place. Backups are
// stored OUTSIDE any server's own filesystem jail — a compromised
// container can read/write only inside its own data directory, never the
// node's shared backup store, so it can neither delete its own backups
// nor inflate its own disk quota by writing into them.
package backup

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/pxhost/agent/internal/fsx"
)

var (
	ErrInvalidArchive  = errors.New("backup: not a valid archive")
	ErrArchiveTooLarge = errors.New("backup: archive exceeds a safety limit")
	ErrNotFound        = errors.New("backup: not found")
)

// Backup describes one stored backup archive.
type Backup struct {
	ID        string    `json:"id"`
	SizeBytes int64     `json:"sizeBytes"`
	SHA256    string    `json:"sha256"`
	CreatedAt time.Time `json:"createdAt"`
}

// Provider is the storage backend for backups — local disk today,
// S3-compatible later (architecture doc 4.5's own stated deferral, hence
// this interface existing at all rather than a single concrete type).
type Provider interface {
	// Create streams every file in src (skipping anything ignore
	// matches) into a new tar.gz, returning its metadata once fully
	// written and checksummed.
	Create(ctx context.Context, serverUUID string, src *fsx.Jail, ignore *IgnoreSet) (Backup, error)
	List(ctx context.Context, serverUUID string) ([]Backup, error)
	Delete(ctx context.Context, serverUUID, backupID string) error
	// Open returns the backup's raw tar.gz bytes and its size, for a
	// signed-URL download — never buffered fully in memory.
	Open(ctx context.Context, serverUUID, backupID string) (io.ReadCloser, int64, error)
	// Restore extracts backupID into dest, a jail already opened on an
	// empty staging directory (never the server's live data directory —
	// the caller does the atomic swap after this returns successfully).
	// Validates the WHOLE archive's headers before writing a single byte
	// (architecture doc 4.5).
	Restore(ctx context.Context, serverUUID, backupID string, dest *fsx.Jail, uid int) error
	// Put streams r into a new archive stored under the caller-chosen id
	// — node-to-node transfer's (roadmap M13) only use: landing bytes
	// fetched from another node's Open endpoint under the SAME id scheme
	// Create/Open/Restore/Delete already use. There is no server-local
	// Jail to walk on the receiving end; the bytes already ARE the
	// tar.gz, so this is Create's mirror image (io.Reader in, not fsx.Jail
	// walked) rather than a reuse of Create itself.
	Put(ctx context.Context, serverUUID, id string, r io.Reader) (Backup, error)
}
