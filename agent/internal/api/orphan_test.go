package api

import (
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/gxhost/agent/internal/dockerx"
)

// TestFindContainerByUUID exercises handleDeleteServer's fallback matching
// logic in isolation from Docker — see routes_create_server.go's doc
// comment on why the manager can lose track of a live container across an
// agent restart, and why the fallback must trust Docker's own label over
// "the manager doesn't know it" when deciding whether a delete is really a
// no-op.
func TestFindContainerByUUID(t *testing.T) {
	list := []container.Summary{
		{ID: "c1", State: "running", Labels: map[string]string{dockerx.ServerUUIDLabel: "server-a"}},
		{ID: "c2", State: "exited", Labels: map[string]string{dockerx.ServerUUIDLabel: "server-b"}},
		{ID: "c3", State: "running", Labels: map[string]string{"unrelated.label": "x"}},
	}

	id, running, found := findContainerByUUID(list, "server-a")
	if !found || id != "c1" || !running {
		t.Fatalf("server-a: got id=%q running=%v found=%v, want c1/true/true", id, running, found)
	}

	id, running, found = findContainerByUUID(list, "server-b")
	if !found || id != "c2" || running {
		t.Fatalf("server-b: got id=%q running=%v found=%v, want c2/false/true", id, running, found)
	}

	_, _, found = findContainerByUUID(list, "server-nonexistent")
	if found {
		t.Fatal("a uuid with no matching container must report found=false, not match something else")
	}

	_, _, found = findContainerByUUID(nil, "server-a")
	if found {
		t.Fatal("an empty container list must never report a match")
	}
}
