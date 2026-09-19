package srv

import "testing"

func TestFindOrphans_MixOfKnownAndOrphaned(t *testing.T) {
	containers := []managedContainer{
		{ID: "c1", UUID: "known-1", Running: true},
		{ID: "c2", UUID: "orphan-1", Running: true},
		{ID: "c3", UUID: "orphan-2", Running: false},
		{ID: "c4", UUID: "known-2", Running: false},
	}
	known := map[string]bool{"known-1": true, "known-2": true}

	orphans := findOrphans(containers, known)
	if len(orphans) != 2 {
		t.Fatalf("expected 2 orphans, got %d: %+v", len(orphans), orphans)
	}
	got := map[string]bool{orphans[0].ID: true, orphans[1].ID: true}
	if !got["c2"] || !got["c3"] {
		t.Fatalf("expected orphans c2 and c3, got %+v", orphans)
	}
}

// TestFindOrphans_ContainerWithNoMatchingServerRow is the exact production
// shape this sweep was added for: the panel says "here is what should
// exist" and the agent's own manager is irrelevant to the decision — a
// container the panel doesn't recognize is an orphan regardless of
// whether the agent process just restarted and forgot everything, or the
// server was deleted while the agent was unreachable.
func TestFindOrphans_ContainerWithNoMatchingServerRow(t *testing.T) {
	containers := []managedContainer{{ID: "c1", UUID: "deleted-server", Running: true}}
	orphans := findOrphans(containers, map[string]bool{"other-server": true})
	if len(orphans) != 1 || orphans[0].ID != "c1" {
		t.Fatalf("expected c1 to be flagged as an orphan, got %+v", orphans)
	}
}

func TestFindOrphans_EmptyLabelNeverOrphaned(t *testing.T) {
	containers := []managedContainer{{ID: "c1", UUID: "", Running: true}}
	orphans := findOrphans(containers, map[string]bool{})
	if len(orphans) != 0 {
		t.Fatalf("a container with no uuid label must never be treated as an orphan, got %+v", orphans)
	}
}

func TestFindOrphans_NoneWhenEverythingKnown(t *testing.T) {
	containers := []managedContainer{
		{ID: "c1", UUID: "a", Running: true},
		{ID: "c2", UUID: "b", Running: false},
	}
	known := map[string]bool{"a": true, "b": true}
	if orphans := findOrphans(containers, known); len(orphans) != 0 {
		t.Fatalf("expected no orphans when every uuid is known, got %+v", orphans)
	}
}
