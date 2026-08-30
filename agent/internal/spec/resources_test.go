package spec

import (
	"reflect"
	"testing"
)

// BuildResources (M12) is the extracted single source of truth for a
// server's cgroup limits — used both by BuildContainerSpec (create) and
// directly by srv.Server.UpdateLimits (live plan-apply). These tests
// exist specifically to catch the two ways that extraction could silently
// regress: BuildResources computing something wrong on its own, or
// BuildContainerSpec's own Resources drifting away from what
// BuildResources now produces.

func TestBuildResources_MatchesWhatBuildContainerSpecProduces(t *testing.T) {
	srv := testServer()
	node := testNode()

	_, hc, _, err := BuildContainerSpec(srv, node)
	mustOK(t, err)

	direct := BuildResources(srv.Limits, node)
	if !reflect.DeepEqual(hc.Resources, direct) {
		t.Fatalf("BuildContainerSpec's Resources diverged from a direct BuildResources call:\nspec:   %+v\ndirect: %+v", hc.Resources, direct)
	}
}

func TestBuildResources_MemoryAndSwap(t *testing.T) {
	r := BuildResources(Limits{MemoryMB: 1024, SwapMB: 512}, testNode())
	wantMem := int64(1024 * 1024 * 1024)
	if r.Memory != wantMem {
		t.Fatalf("Memory = %d, want %d", r.Memory, wantMem)
	}
	if r.MemoryReservation != wantMem*9/10 {
		t.Fatalf("MemoryReservation = %d, want %d", r.MemoryReservation, wantMem*9/10)
	}
	wantSwap := wantMem + 512*1024*1024
	if r.MemorySwap != wantSwap {
		t.Fatalf("MemorySwap = %d, want %d (mem+swap total, per Docker's own semantics)", r.MemorySwap, wantSwap)
	}
}

func TestBuildResources_SwapDisabledByDefault(t *testing.T) {
	r := BuildResources(Limits{MemoryMB: 1024, SwapMB: 0}, testNode())
	if r.MemorySwap != r.Memory {
		t.Fatalf("MemorySwap = %d, want == Memory (%d) when SwapMB=0 disables swap", r.MemorySwap, r.Memory)
	}
}

func TestBuildResources_UnlimitedSwap(t *testing.T) {
	r := BuildResources(Limits{MemoryMB: 1024, SwapMB: -1}, testNode())
	if r.MemorySwap != -1 {
		t.Fatalf("MemorySwap = %d, want -1 (unlimited)", r.MemorySwap)
	}
}

func TestBuildResources_CPUQuota(t *testing.T) {
	if got := BuildResources(Limits{CPUPercent: 150}, testNode()).CPUQuota; got != 150000 {
		t.Fatalf("CPUQuota = %d, want 150000 for 150%%", got)
	}
	if got := BuildResources(Limits{CPUPercent: 0}, testNode()).CPUQuota; got != 0 {
		t.Fatalf("CPUQuota = %d, want 0 (unlimited) for CPUPercent=0", got)
	}
}

func TestBuildResources_PidsLimitDefaultAndCustom(t *testing.T) {
	if got := *BuildResources(Limits{}, testNode()).PidsLimit; got != defaultPidsLimit {
		t.Fatalf("PidsLimit = %d, want default %d", got, defaultPidsLimit)
	}
	if got := *BuildResources(Limits{PidsLimit: 64}, testNode()).PidsLimit; got != 64 {
		t.Fatalf("PidsLimit = %d, want custom 64", got)
	}
}

func TestBuildResources_OomKillNeverDisabled(t *testing.T) {
	// Same invariant as TestBuildContainerSpec_OomKillNeverDisabled — a
	// frozen cgroup on OOM is a node-wide outage waiting to happen,
	// architecture doc 4.6. Not template/plan-configurable, ever.
	r := BuildResources(Limits{}, testNode())
	if r.OomKillDisable == nil || *r.OomKillDisable != false {
		t.Fatalf("OomKillDisable = %v, want false unconditionally", r.OomKillDisable)
	}
}

func TestBuildResources_BlkioWeightOnlyWhenNodeSupportsIt(t *testing.T) {
	node := testNode()
	node.IOWeightSupported = false
	if got := BuildResources(Limits{IOWeight: 500}, node).BlkioWeight; got != 0 {
		t.Fatalf("BlkioWeight = %d, want 0 when node.IOWeightSupported is false", got)
	}

	node.IOWeightSupported = true
	if got := BuildResources(Limits{IOWeight: 500}, node).BlkioWeight; got != 500 {
		t.Fatalf("BlkioWeight = %d, want 500 when node.IOWeightSupported is true", got)
	}
}
