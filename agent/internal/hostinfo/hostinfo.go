// Package hostinfo detects the REAL hardware capacity visible to the
// agent's own process — CPU model/cores/sockets, current CPU load,
// memory used/available, and whether the environment is virtualized.
// Deliberately separate from dockerx.Info(), which is never touched by
// this package: hostinfo only ADDS telemetry dockerx never collected
// (CPU thread/vCPU count and total memory/OS/kernel/container-count
// stay exactly as they were, sourced from the Docker daemon).
//
// Every function here is best-effort per field, by design — the caller
// (serve.go's heartbeat loop) treats each field individually the way it
// already treats a failed dockerx.Info()/fsx.DiskUsage() call: an
// undetected value is simply omitted from that tick's heartbeat, never
// a fabricated zero, and never a reason to fail the heartbeat itself.
// Uses github.com/shirou/gopsutil/v3, which has real implementations on
// every platform gopsutil supports (including Windows) — unlike
// fsx/disk.go's syscall.Statfs, nothing here needs a linux/!linux
// build-tag split.
package hostinfo

import (
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
)

// StaticInfo changes only across a reboot/reconfiguration — callers
// should cache this the same way serve.go already caches dockerx.Info()
// (a 5-minute TTL).
type StaticInfo struct {
	CPUModel string // "" if undetermined

	// Both 0 (undetermined/withheld) unless PhysicalTopologyReliable —
	// see CollectStatic's doc comment for the LXC case that withholds
	// them deliberately, not because detection failed.
	CPUPhysicalCores         int
	CPUSockets               int
	PhysicalTopologyReliable bool

	VirtualizationSystem string // "kvm", "lxc", "" (bare metal or undetected)
	VirtualizationRole   string // "guest", "host", ""

	// The node's OWN cgroup memory limit — capacity plan (auto-derivation)'s
	// fix for the LXC/Proxmox problem: mem.VirtualMemory()'s "total" (used
	// by dockerx.Info's MemTotal too) reads /proc/meminfo, which an LXC
	// guest without lxcfs sees UN-namespaced — the Proxmox HOST's full RAM,
	// not the guest's actual share. This field is the guest's real ceiling.
	// MemoryLimitValid is false (never a fabricated value) when no cgroup
	// limit file exists (non-Linux, or a cgroup-less environment) or when
	// the environment is genuinely unlimited — see readMemoryLimit.
	MemoryLimitBytes uint64
	MemoryLimitValid bool
}

// DynamicInfo changes every tick — callers should re-collect this on
// every heartbeat, the same cadence fsx.DiskUsage() already runs at.
type DynamicInfo struct {
	CPUUsagePercent int // 0-100 rounded; -1 if undetermined
	LoadAvg1        float64
	LoadAvgValid    bool

	MemoryUsedBytes      uint64
	MemoryAvailableBytes uint64
	MemoryValid          bool
}

// CollectStatic reads CPU model/topology and virtualization detection.
//
// Physical core/socket counts are DELIBERATELY withheld
// (PhysicalTopologyReliable = false) whenever the environment is
// detected as an LXC container: the Linux kernel does not namespace
// /proc/cpuinfo, so a Proxmox LXC guest normally sees the HOST's full
// core/socket topology, not its own cgroup-limited share. Reporting
// that number as the Node's "physical cores" would be exactly the
// host-hardware-leaking-into-a-guest's-declared-capacity bug this
// feature exists to prevent. The CPU model string is still reported in
// that case — it's true information, the vCPU really is running on that
// silicon — and the actual usable thread/vCPU count keeps coming from
// dockerx.Info()'s NCPU (sched_getaffinity-based, already correct under
// a configured LXC cpuset); this package never touches that value.
func CollectStatic() StaticInfo {
	var out StaticInfo

	info, cpuErr := cpu.Info()
	if cpuErr == nil && len(info) > 0 {
		out.CPUModel = info[0].ModelName
	}

	hostInfo, hostErr := host.Info()
	if hostErr == nil {
		out.VirtualizationSystem = hostInfo.VirtualizationSystem
		out.VirtualizationRole = hostInfo.VirtualizationRole
	}

	isLXC := hostErr == nil && hostInfo.VirtualizationSystem == "lxc"
	if !isLXC && cpuErr == nil {
		if cores, err := cpu.Counts(false); err == nil && cores > 0 {
			out.CPUPhysicalCores = cores
			out.PhysicalTopologyReliable = true
		}
		sockets := make(map[string]struct{})
		for _, c := range info {
			if c.PhysicalID != "" {
				sockets[c.PhysicalID] = struct{}{}
			}
		}
		if len(sockets) > 0 {
			out.CPUSockets = len(sockets)
		}
	}

	if limit, ok := readMemoryLimit(); ok {
		out.MemoryLimitBytes = limit
		out.MemoryLimitValid = true
	}

	return out
}

const (
	cgroupV2MemoryMax   = "/sys/fs/cgroup/memory.max"
	cgroupV1MemoryLimit = "/sys/fs/cgroup/memory/memory.limit_in_bytes"
)

// cgroup v1 reports "no limit" as a huge sentinel close to the max
// representable size (canonically 9223372036854771712 on 64-bit —
// PAGE_COUNTER_MAX rounded to page size — but not a clean constant
// across kernels/page sizes). A real machine's RAM is always
// comfortably below 1 PiB, so anything at or above this threshold is
// treated as "no limit set," the same meaning cgroup v2's literal
// "max" string already has.
const unlimitedCgroupV1Threshold = uint64(1) << 50

// readMemoryLimit reads the cgroup memory limit — v2 first
// (memory.max, "max" = unlimited), falling back to v1
// (memory.limit_in_bytes, a huge sentinel = unlimited). Best-effort
// like everything else in this package: ok=false whenever no limit
// file exists (non-Linux, or a cgroup-less environment) or the
// environment is genuinely unlimited, never a fabricated value.
func readMemoryLimit() (limitBytes uint64, ok bool) {
	if raw, err := os.ReadFile(cgroupV2MemoryMax); err == nil {
		s := strings.TrimSpace(string(raw))
		if s == "max" {
			return 0, false
		}
		if v, err := strconv.ParseUint(s, 10, 64); err == nil && v > 0 {
			return v, true
		}
		return 0, false
	}
	if raw, err := os.ReadFile(cgroupV1MemoryLimit); err == nil {
		s := strings.TrimSpace(string(raw))
		if v, err := strconv.ParseUint(s, 10, 64); err == nil && v > 0 && v < unlimitedCgroupV1Threshold {
			return v, true
		}
		return 0, false
	}
	return 0, false
}

// CollectDynamic reads CPU%, 1-minute load average, and memory
// used/available. The 200ms blocking sample gopsutil needs for an
// accurate CPU% is negligible against the heartbeat's own 15s+ tick
// interval and its own network round trip.
func CollectDynamic() DynamicInfo {
	out := DynamicInfo{CPUUsagePercent: -1}

	if percents, err := cpu.Percent(200*time.Millisecond, false); err == nil && len(percents) > 0 {
		p := percents[0]
		switch {
		case p < 0:
			p = 0
		case p > 100:
			p = 100
		}
		out.CPUUsagePercent = int(p + 0.5)
	}

	if avg, err := load.Avg(); err == nil {
		out.LoadAvg1 = avg.Load1
		out.LoadAvgValid = true
	}

	if vm, err := mem.VirtualMemory(); err == nil {
		out.MemoryUsedBytes = vm.Used
		out.MemoryAvailableBytes = vm.Available
		out.MemoryValid = true
	}

	return out
}
