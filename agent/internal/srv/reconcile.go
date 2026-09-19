package srv

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/gxhost/agent/internal/dockerx"
)

// managedContainer is the minimal shape ReconcileOrphans needs from a
// Docker container listing. It exists so findOrphans below has no
// dependency on the Docker SDK's container.Summary and can be unit tested
// without a real daemon — dockerx.Client is a concrete wrapper with no
// fake-able seam (see this package's other _test.go files for the same
// reasoning), so Docker-touching code itself is proven live, not here.
type managedContainer struct {
	ID      string
	UUID    string
	Running bool
}

// findOrphans returns every managedContainer whose UUID is not present in
// knownUUIDs — the pure decision half of ReconcileOrphans.
func findOrphans(containers []managedContainer, knownUUIDs map[string]bool) []managedContainer {
	var orphans []managedContainer
	for _, c := range containers {
		if c.UUID == "" {
			// A managed container with no uuid label is a bug elsewhere
			// (spec.buildLabels always sets one), not a signal this sweep
			// should act on — never tear down blind.
			continue
		}
		if !knownUUIDs[c.UUID] {
			orphans = append(orphans, c)
		}
	}
	return orphans
}

// ReconcileOrphans compares every Docker container carrying gxhost's
// managed label against the authoritative set of server UUIDs the panel
// still has a row for, and force-tears-down any container whose UUID
// isn't in that set.
//
// This is the OTHER direction from cmd/pxagent's reconcileManagedContainers,
// and the two are meant to run together: that one rebuilds the manager at
// boot from Docker's durable labels, adopting every managed container it
// finds; this one asks the panel which servers still exist and tears down
// whatever the panel no longer recognizes. Boot adoption alone would
// happily re-adopt — and keep alive forever — a container whose server row
// was hard-deleted while this agent was down, which nothing else would
// ever come back to clean up: the panel's delete doesn't wait for an
// offline agent, and no further delete request is ever going to arrive for
// a row that no longer exists.
//
// That matters beyond tidiness, because an orphaned container keeps its
// allocated host port bound. Docker then refuses to publish that port for
// the NEW server the panel assigns it to — and leaves that new container
// running with no network attachment at all, silently, with nothing in the
// daemon log. Found live on node01-r620.
//
// Containers removed here are dropped from the manager too: after boot
// adoption an orphan IS registered, and leaving the entry behind would
// leave a server pointing at a container id that no longer exists.
func ReconcileOrphans(ctx context.Context, m *Manager, dc *dockerx.Client, knownUUIDs map[string]bool, log *slog.Logger) ([]string, error) {
	list, err := dc.ListManaged(ctx)
	if err != nil {
		return nil, fmt.Errorf("srv: listing managed containers: %w", err)
	}

	containers := make([]managedContainer, 0, len(list))
	for _, c := range list {
		containers = append(containers, managedContainer{
			ID:      c.ID,
			UUID:    c.Labels[dockerx.ServerUUIDLabel],
			Running: c.State == "running",
		})
	}

	var removed []string
	for _, orphan := range findOrphans(containers, knownUUIDs) {
		if orphan.Running {
			if err := dc.KillContainer(ctx, orphan.ID); err != nil {
				log.Warn("reconcile: failed to kill orphaned container", "uuid", orphan.UUID, "container", orphan.ID, "err", err)
				continue
			}
		}
		if err := dc.RemoveContainer(ctx, orphan.ID, true); err != nil {
			log.Warn("reconcile: failed to remove orphaned container", "uuid", orphan.UUID, "container", orphan.ID, "err", err)
			continue
		}
		m.Remove(orphan.UUID)
		log.Warn("reconcile: removed orphaned container with no matching server on the panel", "uuid", orphan.UUID, "container", orphan.ID)
		removed = append(removed, orphan.UUID)
	}
	return removed, nil
}
