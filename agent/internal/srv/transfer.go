package srv

import (
	"context"
	"fmt"

	"github.com/pxhost/agent/internal/backup"
)

// Export streams the server's current files into a transfer archive via
// provider — the source half of a node-to-node transfer (architecture
// doc roadmap M13). Unlike Backup, this REQUIRES the server to already
// be stopped: a transfer is a one-way, irreversible move (the source
// container and data directory are deleted once the target confirms
// success), so an in-flight write during export would be real,
// unrecoverable data loss in a way a backup alongside a still-live
// original never risks. Reuses ErrServerNotStopped/409 mapping — same
// caller-facing contract as Restore.
func (s *Server) Export(ctx context.Context, provider backup.Provider) (backup.Backup, error) {
	s.mu.Lock()
	state := s.State
	s.mu.Unlock()
	if state != StateOffline {
		return backup.Backup{}, fmt.Errorf("%w (current state: %s)", ErrServerNotStopped, state)
	}
	return provider.Create(ctx, s.UUID, s.Jail, backup.NewIgnoreSet())
}
