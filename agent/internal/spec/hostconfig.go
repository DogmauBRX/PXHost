package spec

import (
	"fmt"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/strslice"
	"github.com/docker/go-connections/nat"
)

// BuildContainerSpec is the pure function every PXHost container is built
// from. It is deliberately side-effect-free: no Docker calls, no
// filesystem access beyond what the caller already resolved into Node/
// Server. That purity is what lets every isolation invariant below be
// asserted by a 2-second unit test instead of a slow Docker-backed one
// (architecture doc 4.1 / 4.3).
//
// The security posture is unconditional, not template-configurable:
// no privileged mode, no host namespaces, no added capabilities, no
// writable rootfs, no restart policy (the agent owns crash/restart
// decisions, never Docker), and a bounded log driver so a spammy or
// crash-looping process cannot fill the node's disk.
func BuildContainerSpec(srv Server, node Node) (*container.Config, *container.HostConfig, *network.NetworkingConfig, error) {
	if err := validateServer(srv, node); err != nil {
		return nil, nil, nil, err
	}

	argv, err := BuildArgv(srv.StartupTmpl, srv.Env)
	if err != nil {
		return nil, nil, nil, err
	}

	stopSignal := srv.StopSignal
	if stopSignal == "" {
		stopSignal = "SIGTERM"
	}

	cfg := &container.Config{
		Image:        srv.Image,
		Entrypoint:   strslice.StrSlice(argv),
		Cmd:          nil, // never set alongside a custom Entrypoint — avoids ambiguity with the image's own CMD
		WorkingDir:   "/home/container",
		User:         fmt.Sprintf("%d:%d", srv.UID, srv.UID),
		Tty:          false, // a TTY would merge stdout/stderr and allow escape-sequence injection into the console
		OpenStdin:    true,
		StdinOnce:    false,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		StopSignal:   stopSignal,
		Healthcheck: &container.HealthConfig{
			Test: []string{"NONE"}, // a template-supplied healthcheck is another exec surface; disabled unconditionally
		},
		Labels: buildLabels(srv, node),
	}

	dataMount, err := BuildDataMount(node, srv)
	if err != nil {
		return nil, nil, nil, err
	}
	extraMounts, rejected, err := BuildExtraMounts(node, srv.Mounts)
	if err != nil {
		return nil, nil, nil, err
	}
	_ = rejected // surfaced to the caller via BuildExtraMounts's own return in higher layers; spec stays pure here

	mounts := make([]mount.Mount, 0, 1+len(extraMounts))
	mounts = append(mounts, toDockerMount(dataMount))
	for _, m := range extraMounts {
		mounts = append(mounts, toDockerMount(m))
	}

	portBindings, exposedPorts := buildPortBindings(srv.Allocations)
	cfg.ExposedPorts = exposedPorts

	logMaxSize := node.LogMaxSize
	if logMaxSize == "" {
		logMaxSize = "8m"
	}
	logMaxFile := node.LogMaxFile
	if logMaxFile == "" {
		logMaxFile = "3"
	}

	securityOpt := []string{"no-new-privileges:true"}
	if node.SeccompProfileJSON != "" {
		securityOpt = append(securityOpt, "seccomp="+node.SeccompProfileJSON)
	}
	if node.ApparmorProfile != "" {
		securityOpt = append(securityOpt, "apparmor="+node.ApparmorProfile)
	}

	hc := &container.HostConfig{
		// ---- isolation: every namespace is private to the container ----
		Privileged:     false,
		NetworkMode:    container.NetworkMode(node.NetworkName),
		PidMode:        "",
		IpcMode:        container.IPCModePrivate,
		UTSMode:        "",
		UsernsMode:     "",
		CgroupnsMode:   container.CgroupnsModePrivate,
		ReadonlyRootfs: true,
		Tmpfs: map[string]string{
			"/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
			"/run": "rw,noexec,nosuid,nodev,size=8m,mode=0755",
		},
		SecurityOpt: securityOpt,
		CapDrop:     strslice.StrSlice{"ALL"},
		CapAdd:      strslice.StrSlice{}, // intentionally empty, always

		Mounts:       mounts,
		PortBindings: portBindings,

		// The agent owns crash/restart decisions (with a budget + circuit
		// breaker) — Docker's own restart policy would fight suspension
		// and panel-driven power state.
		RestartPolicy: container.RestartPolicy{Name: "no"},
		AutoRemove:    false,

		LogConfig: container.LogConfig{
			Type:   "local",
			Config: map[string]string{"max-size": logMaxSize, "max-file": logMaxFile},
		},

		Resources: BuildResources(srv.Limits, node),
	}

	netCfg := &network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{
			node.NetworkName: {},
		},
	}

	return cfg, hc, netCfg, nil
}

func validateServer(srv Server, node Node) error {
	if srv.Image == "" {
		return fmt.Errorf("spec: server image is empty")
	}
	if srv.UID < node.UIDRangeMin || srv.UID > node.UIDRangeMax || srv.UID == 0 {
		return fmt.Errorf("spec: uid %d is outside the node's configured range [%d, %d] or is root",
			srv.UID, node.UIDRangeMin, node.UIDRangeMax)
	}
	if srv.Limits.MemoryMB <= 0 {
		return fmt.Errorf("spec: memory limit must be > 0")
	}
	if srv.Limits.DiskMB <= 0 {
		return fmt.Errorf("spec: disk limit must be > 0")
	}
	hasPrimary := false
	for _, a := range srv.Allocations {
		if a.Port < minHostPort || a.Port > maxHostPort {
			return fmt.Errorf("spec: allocation port %d is outside the permitted range [%d, %d]", a.Port, minHostPort, maxHostPort)
		}
		if a.IP == "" {
			return fmt.Errorf("spec: allocation missing an IP")
		}
		if a.Primary {
			hasPrimary = true
		}
	}
	if len(srv.Allocations) > 0 && !hasPrimary {
		return fmt.Errorf("spec: server has allocations but none is marked primary")
	}
	return nil
}

func buildLabels(srv Server, node Node) map[string]string {
	return map[string]string{
		"pxhost.managed":      "true",
		"pxhost.server.uuid":  srv.UUID,
		"pxhost.server.uid":   fmt.Sprintf("%d", srv.UID),
		"pxhost.spec.version": specVersion,
	}
}

// specVersion is bumped whenever the security-relevant shape of
// BuildContainerSpec changes. The agent compares this label on boot
// reconciliation to flag containers that need a recreate to pick up new
// hardening (architecture doc 4.3).
const specVersion = "1"

func toDockerMount(m Mount) mount.Mount {
	return mount.Mount{
		Type:     mount.TypeBind,
		Source:   m.Source,
		Target:   m.Target,
		ReadOnly: m.ReadOnly,
		BindOptions: &mount.BindOptions{
			Propagation:  mount.PropagationRPrivate,
			NonRecursive: m.NonRecursive,
		},
	}
}

func buildPortBindings(allocs []Allocation) (nat.PortMap, nat.PortSet) {
	bindings := nat.PortMap{}
	exposed := nat.PortSet{}
	for _, a := range allocs {
		protos := a.Protocols
		if len(protos) == 0 {
			protos = []string{"tcp", "udp"}
		}
		for _, proto := range protos {
			p := nat.Port(fmt.Sprintf("%d/%s", a.Port, proto))
			exposed[p] = struct{}{}
			// Host port == container port, always: game protocols embed the
			// port in server-list/query responses, so NAT-style remapping
			// breaks them (architecture doc 4.3).
			bindings[p] = append(bindings[p], nat.PortBinding{
				HostIP:   a.IP,
				HostPort: fmt.Sprintf("%d", a.Port),
			})
		}
	}
	return bindings, exposed
}

// BuildResources is the single source of truth for a server's cgroup
// limits — extracted out of BuildContainerSpec (M12) so a live resource
// UPDATE (architecture doc 2.1/9: plan-apply pushing a changed plan's
// limits onto a server's already-running container, via Docker's
// ContainerUpdate — no recreate, no restart) computes byte-for-byte the
// SAME values a fresh create would, rather than a second hand-maintained
// copy of this math silently drifting from it over time.
func BuildResources(limits Limits, node Node) container.Resources {
	pidsLimit := limits.PidsLimit
	if pidsLimit == 0 {
		pidsLimit = defaultPidsLimit
	}
	memBytes := limits.MemoryMB * 1024 * 1024

	var blkioWeight uint16
	if node.IOWeightSupported {
		blkioWeight = uint16(clampInt(limits.IOWeight, 10, 1000, 500))
	}

	return container.Resources{
		CgroupParent:      node.CgroupParent,
		Memory:            memBytes,
		MemoryReservation: memBytes * 9 / 10,
		MemorySwap:        memSwapBytes(limits),
		MemorySwappiness:  int64Ptr(0),
		OomKillDisable:    boolPtr(false), // ALWAYS false: a frozen cgroup on OOM is a node-wide outage waiting to happen
		CPUPeriod:         100000,
		CPUQuota:          cpuQuota(limits.CPUPercent),
		BlkioWeight:       blkioWeight,
		PidsLimit:         &pidsLimit,
		Ulimits: []*container.Ulimit{
			{Name: "nofile", Soft: defaultNoFile, Hard: defaultNoFile},
			{Name: "nproc", Soft: defaultNProc, Hard: defaultNProc},
			{Name: "core", Soft: 0, Hard: 0},
			{Name: "memlock", Soft: 0, Hard: 0},
		},
	}
}

func memSwapBytes(l Limits) int64 {
	if l.SwapMB < 0 {
		return -1 // unlimited
	}
	memBytes := l.MemoryMB * 1024 * 1024
	swapBytes := l.SwapMB * 1024 * 1024
	return memBytes + swapBytes // Docker's MemorySwap is the TOTAL (mem+swap) ceiling; swap 0 => MemorySwap == Memory, disabling swap
}

func cpuQuota(percent int) int64 {
	if percent <= 0 {
		return 0 // 0 = unlimited, matches Docker's own semantics for CPUQuota
	}
	return int64(percent) * 1000 // CPUPeriod is fixed at 100000us, so percent*1000 == percent% of one core
}

func clampInt(v, lo, hi, def int) int {
	if v == 0 {
		return def
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func int64Ptr(v int64) *int64 { return &v }
func boolPtr(v bool) *bool    { return &v }
