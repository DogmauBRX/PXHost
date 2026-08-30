package stats

import (
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
)

func TestNormalize_CPUPercentReflectsHostShareAndOnlineCPUs(t *testing.T) {
	prev := container.StatsResponse{
		CPUStats: container.CPUStats{
			CPUUsage:    container.CPUUsage{TotalUsage: 1_000_000_000},
			SystemUsage: 10_000_000_000,
			OnlineCPUs:  4,
		},
	}
	cur := container.StatsResponse{
		CPUStats: container.CPUStats{
			// container used 2s of CPU time while 2s of system time passed,
			// across 4 online CPUs -> (2/2)*4*100 = 400%
			CPUUsage:    container.CPUUsage{TotalUsage: 3_000_000_000},
			SystemUsage: 12_000_000_000,
			OnlineCPUs:  4,
		},
	}
	f := Normalize(cur, prev, "running", 0, 0, 0, 0, 0)
	if f.CPUPercent != 400 {
		t.Fatalf("expected CPUPercent=400, got %v", f.CPUPercent)
	}
}

func TestNormalize_ZeroSystemDeltaNeverDividesByZero(t *testing.T) {
	prev := container.StatsResponse{CPUStats: container.CPUStats{SystemUsage: 1000}}
	cur := container.StatsResponse{CPUStats: container.CPUStats{SystemUsage: 1000}} // no time passed
	f := Normalize(cur, prev, "running", 0, 0, 0, 0, 0)
	if f.CPUPercent != 0 {
		t.Fatalf("expected CPUPercent=0 when system delta is zero, got %v", f.CPUPercent)
	}
}

// This is the single most common bug in naive Docker stats displays
// (architecture doc 4.5): page cache counts toward the raw `usage` figure,
// so without subtracting it every idle container appears to sit near its
// memory limit.
func TestNormalize_MemorySubtractsPageCache(t *testing.T) {
	cur := container.StatsResponse{
		MemoryStats: container.MemoryStats{
			Usage: 900 * 1024 * 1024,
			Stats: map[string]uint64{"inactive_file": 700 * 1024 * 1024},
		},
	}
	f := Normalize(cur, container.StatsResponse{}, "running", 1024*1024*1024, 100, 0, 0, 0)
	want := uint64(200 * 1024 * 1024)
	if f.MemoryBytes != want {
		t.Fatalf("expected MemoryBytes=%d (usage minus page cache), got %d", want, f.MemoryBytes)
	}
}

func TestNormalize_CacheLargerThanUsageNeverUnderflows(t *testing.T) {
	cur := container.StatsResponse{
		MemoryStats: container.MemoryStats{
			Usage: 10,
			Stats: map[string]uint64{"inactive_file": 999}, // pathological/racy sample
		},
	}
	f := Normalize(cur, container.StatsResponse{}, "running", 1024, 100, 0, 0, 0)
	if f.MemoryBytes != 10 {
		t.Fatalf("expected MemoryBytes to fall back to raw usage (10) rather than underflow, got %d", f.MemoryBytes)
	}
}

func TestNormalize_NetworkSumsAllInterfaces(t *testing.T) {
	cur := container.StatsResponse{
		Networks: map[string]container.NetworkStats{
			"eth0": {RxBytes: 100, TxBytes: 50},
			"eth1": {RxBytes: 25, TxBytes: 10},
		},
	}
	f := Normalize(cur, container.StatsResponse{}, "running", 0, 0, 0, 0, 0)
	if f.NetworkRxBytes != 125 || f.NetworkTxBytes != 60 {
		t.Fatalf("expected summed network bytes rx=125 tx=60, got rx=%d tx=%d", f.NetworkRxBytes, f.NetworkTxBytes)
	}
}

func TestNormalize_PassesThroughLimitsAndUptime(t *testing.T) {
	f := Normalize(container.StatsResponse{}, container.StatsResponse{}, "running", 2048, 150, 4096, 8192, 90*time.Second)
	if f.MemoryLimitBytes != 2048 || f.CPULimitPercent != 150 {
		t.Fatalf("expected limits to pass through unchanged, got mem=%d cpu=%v", f.MemoryLimitBytes, f.CPULimitPercent)
	}
	if f.DiskBytes != 4096 || f.DiskLimitBytes != 8192 {
		t.Fatalf("expected disk figures to pass through unchanged, got used=%d limit=%d", f.DiskBytes, f.DiskLimitBytes)
	}
	if f.UptimeMS != 90_000 {
		t.Fatalf("expected UptimeMS=90000, got %d", f.UptimeMS)
	}
}
