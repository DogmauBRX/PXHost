package spec

import (
	"testing"

	"github.com/docker/docker/api/types/container"
)

func testNode() Node {
	return Node{
		DataDir:      "/var/lib/pxhost/servers",
		NetworkName:  "pxhost0",
		CgroupParent: "pxhost.slice",
		UIDRangeMin:  100000,
		UIDRangeMax:  165535,
	}
}

func testServer() Server {
	return Server{
		UUID:        "9c2e0000-0000-0000-0000-000000000001",
		UID:         100042,
		Image:       "ghcr.io/pxhost/java:21@sha256:" + fakeDigest(),
		StartupTmpl: `java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui`,
		Env:         map[string]string{"SERVER_MEMORY": "2048", "SERVER_JARFILE": "server.jar"},
		Limits: Limits{
			CPUPercent: 200, MemoryMB: 2048, SwapMB: 0, DiskMB: 10240, IOWeight: 500,
		},
		Allocations: []Allocation{{IP: "203.0.113.10", Port: 25565, Primary: true}},
	}
}

func fakeDigest() string {
	return "abcd0000000000000000000000000000000000000000000000000000000000"
}

// --- The invariants below are exactly the ones the threat model (architecture
// doc 4.6) requires. Each assertion here is what turns a 6-minute Docker
// integration job into a 2-second unit test.

func TestBuildContainerSpec_NeverPrivileged(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if hc.Privileged {
		t.Fatal("container must never be privileged")
	}
}

func TestBuildContainerSpec_AllCapabilitiesDroppedNoneAdded(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if len(hc.CapDrop) != 1 || hc.CapDrop[0] != "ALL" {
		t.Fatalf("expected CapDrop=[ALL], got %v", hc.CapDrop)
	}
	if len(hc.CapAdd) != 0 {
		t.Fatalf("expected CapAdd to be empty, got %v", hc.CapAdd)
	}
}

func TestBuildContainerSpec_NoNewPrivileges(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if !hasSecurityOpt(hc.SecurityOpt, "no-new-privileges:true") {
		t.Fatalf("expected no-new-privileges:true in SecurityOpt, got %v", hc.SecurityOpt)
	}
}

func TestBuildContainerSpec_OwnNamespacesNeverHostShared(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if hc.PidMode.IsHost() {
		t.Fatal("PID namespace must never be shared with the host")
	}
	if hc.PidMode.IsContainer() {
		t.Fatal("PID namespace must never be shared with another container")
	}
	if hc.IpcMode != container.IPCModePrivate {
		t.Fatalf("expected private IPC namespace, got %q", hc.IpcMode)
	}
	if hc.UTSMode.IsHost() {
		t.Fatal("UTS namespace must never be shared with the host")
	}
	if hc.UsernsMode.IsHost() {
		t.Fatal("user namespace must never be shared with the host")
	}
}

func TestBuildContainerSpec_NetworkModeIsNeverHostOrNone(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if hc.NetworkMode.IsHost() {
		t.Fatal("NetworkMode must never be host")
	}
	if hc.NetworkMode.IsNone() {
		t.Fatal("NetworkMode must never be none (that would defeat the DOCKER-USER egress policy path)")
	}
	if string(hc.NetworkMode) != "pxhost0" {
		t.Fatalf("expected the configured node bridge network, got %q", hc.NetworkMode)
	}
}

func TestBuildContainerSpec_ReadOnlyRootfsAndBoundedTmpfs(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if !hc.ReadonlyRootfs {
		t.Fatal("rootfs must be read-only")
	}
	tmp, ok := hc.Tmpfs["/tmp"]
	if !ok {
		t.Fatal("expected a /tmp tmpfs mount")
	}
	for _, want := range []string{"noexec", "nosuid", "nodev", "size=64m"} {
		if !containsSubstr(tmp, want) {
			t.Fatalf("/tmp tmpfs options %q missing %q", tmp, want)
		}
	}
}

func TestBuildContainerSpec_NoDeviceOfDockerSocketEverMounted(t *testing.T) {
	srv := testServer()
	srv.Mounts = []MountRequest{{Source: "/var/run/docker.sock", Target: "/home/container/sock", ReadOnly: true}}
	node := testNode()
	// even with an (incorrectly) permissive allowlist entry, the socket check must win
	node.MountAllowlist = []MountAllowlistEntry{{
		Source: "/var/run/docker.sock", Targets: []string{"/home/container/sock"},
	}}
	_, hc, _, err := BuildContainerSpec(srv, node)
	mustOK(t, err)
	for _, m := range hc.Mounts {
		if containsSubstr(m.Source, "docker.sock") {
			t.Fatalf("docker.sock must never appear as a mount source, got %+v", m)
		}
	}
}

func TestBuildContainerSpec_ExactlyOneDataMountByDefault(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if len(hc.Mounts) != 1 {
		t.Fatalf("expected exactly one mount with no admin extras, got %d: %+v", len(hc.Mounts), hc.Mounts)
	}
	m := hc.Mounts[0]
	if m.Target != "/home/container" {
		t.Fatalf("expected data mount target /home/container, got %q", m.Target)
	}
	if m.BindOptions == nil || !m.BindOptions.NonRecursive {
		t.Fatal("data mount must be NonRecursive")
	}
}

func TestBuildContainerSpec_UnallowlistedExtraMountIsSilentlyRejectedNotFatal(t *testing.T) {
	srv := testServer()
	srv.Mounts = []MountRequest{{Source: "/opt/not-allowlisted", Target: "/home/container/x"}}
	_, hc, _, err := BuildContainerSpec(srv, testNode()) // node has an empty allowlist
	mustOK(t, err)
	if len(hc.Mounts) != 1 {
		t.Fatalf("a mount not present in the node allowlist must be dropped, got %d mounts", len(hc.Mounts))
	}
}

func TestBuildContainerSpec_OomKillNeverDisabled(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if hc.Resources.OomKillDisable == nil || *hc.Resources.OomKillDisable {
		t.Fatal("OomKillDisable must always be false: a frozen cgroup on OOM is a node-wide outage")
	}
}

func TestBuildContainerSpec_MemoryLimitsAndSwapDisabledByDefault(t *testing.T) {
	srv := testServer()
	srv.Limits.MemoryMB = 2048
	srv.Limits.SwapMB = 0
	_, hc, _, err := BuildContainerSpec(srv, testNode())
	mustOK(t, err)
	wantMem := int64(2048 * 1024 * 1024)
	if hc.Resources.Memory != wantMem {
		t.Fatalf("expected Memory=%d, got %d", wantMem, hc.Resources.Memory)
	}
	if hc.Resources.MemorySwap != wantMem {
		t.Fatalf("expected MemorySwap == Memory (swap disabled) when SwapMB=0, got %d vs mem %d", hc.Resources.MemorySwap, wantMem)
	}
	if hc.Resources.MemorySwappiness == nil || *hc.Resources.MemorySwappiness != 0 {
		t.Fatal("expected MemorySwappiness=0")
	}
}

func TestBuildContainerSpec_CPUQuotaMatchesPercent(t *testing.T) {
	srv := testServer()
	srv.Limits.CPUPercent = 150
	_, hc, _, err := BuildContainerSpec(srv, testNode())
	mustOK(t, err)
	if hc.Resources.CPUPeriod != 100000 {
		t.Fatalf("expected CPUPeriod=100000, got %d", hc.Resources.CPUPeriod)
	}
	if hc.Resources.CPUQuota != 150000 {
		t.Fatalf("expected CPUQuota=150000 for 150%%, got %d", hc.Resources.CPUQuota)
	}
}

func TestBuildContainerSpec_PidsLimitDefaultAndCustom(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if hc.Resources.PidsLimit == nil || *hc.Resources.PidsLimit != defaultPidsLimit {
		t.Fatalf("expected default PidsLimit=%d, got %v", defaultPidsLimit, hc.Resources.PidsLimit)
	}

	srv := testServer()
	srv.Limits.PidsLimit = 64
	_, hc2, _, err := BuildContainerSpec(srv, testNode())
	mustOK(t, err)
	if *hc2.Resources.PidsLimit != 64 {
		t.Fatalf("expected custom PidsLimit=64, got %d", *hc2.Resources.PidsLimit)
	}
}

func TestBuildContainerSpec_RestartPolicyIsAlwaysNo(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if hc.RestartPolicy.Name != "no" {
		t.Fatalf("expected restart policy 'no' (the agent owns crash-restart decisions), got %q", hc.RestartPolicy.Name)
	}
}

func TestBuildContainerSpec_LogDriverIsBounded(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if hc.LogConfig.Config["max-size"] == "" || hc.LogConfig.Config["max-file"] == "" {
		t.Fatal("expected a bounded log driver config (max-size/max-file) to prevent disk fill via stdout spam")
	}
}

func TestBuildContainerSpec_NonRootUser(t *testing.T) {
	cfg, _, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if cfg.User == "" || cfg.User == "0:0" || cfg.User == "root" {
		t.Fatalf("expected a non-root User, got %q", cfg.User)
	}
}

func TestBuildContainerSpec_RejectsRootUID(t *testing.T) {
	srv := testServer()
	srv.UID = 0
	_, _, _, err := BuildContainerSpec(srv, testNode())
	if err == nil {
		t.Fatal("expected rejection of uid 0")
	}
}

func TestBuildContainerSpec_RejectsUIDOutsideNodeRange(t *testing.T) {
	srv := testServer()
	srv.UID = 99999 // below node's configured 100000-165535 range
	_, _, _, err := BuildContainerSpec(srv, testNode())
	if err == nil {
		t.Fatal("expected rejection of a uid outside the node's configured range")
	}
}

func TestBuildContainerSpec_NoTTY(t *testing.T) {
	cfg, _, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if cfg.Tty {
		t.Fatal("Tty must be false: a TTY merges stdout/stderr and enables escape-sequence injection into the console")
	}
}

func TestBuildContainerSpec_HealthcheckDisabled(t *testing.T) {
	cfg, _, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if cfg.Healthcheck == nil || len(cfg.Healthcheck.Test) == 0 || cfg.Healthcheck.Test[0] != "NONE" {
		t.Fatal("expected Healthcheck.Test=[NONE]: a template-supplied healthcheck is another exec surface")
	}
}

func TestBuildContainerSpec_PortBindingsSamePortHostAndContainer(t *testing.T) {
	_, hc, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	found := 0
	for port, bindings := range hc.PortBindings {
		for _, b := range bindings {
			found++
			if b.HostPort != port.Port() {
				t.Fatalf("expected identical host/container port (no NAT remap), got container=%s host=%s", port.Port(), b.HostPort)
			}
			if b.HostIP != "203.0.113.10" {
				t.Fatalf("expected the allocation's IP, got %q", b.HostIP)
			}
		}
	}
	if found == 0 {
		t.Fatal("expected at least one port binding for the primary allocation")
	}
}

func TestBuildContainerSpec_RejectsPrivilegedPortAllocation(t *testing.T) {
	srv := testServer()
	srv.Allocations = []Allocation{{IP: "203.0.113.10", Port: 22, Primary: true}}
	_, _, _, err := BuildContainerSpec(srv, testNode())
	if err == nil {
		t.Fatal("expected rejection of a sub-1024 port (no CAP_NET_BIND_SERVICE is ever granted)")
	}
}

func TestBuildContainerSpec_SpecVersionLabelPresent(t *testing.T) {
	cfg, _, _, err := BuildContainerSpec(testServer(), testNode())
	mustOK(t, err)
	if cfg.Labels["pxhost.spec.version"] == "" {
		t.Fatal("expected a pxhost.spec.version label so boot reconciliation can flag stale containers for recreate")
	}
	if cfg.Labels["pxhost.managed"] != "true" {
		t.Fatal("expected pxhost.managed=true label")
	}
	if cfg.Labels["pxhost.server.uuid"] != testServer().UUID {
		t.Fatal("expected the server uuid label")
	}
}

func TestBuildContainerSpec_IsDeterministic(t *testing.T) {
	srv, node := testServer(), testNode()
	cfg1, hc1, _, err1 := BuildContainerSpec(srv, node)
	cfg2, hc2, _, err2 := BuildContainerSpec(srv, node)
	mustOK(t, err1)
	mustOK(t, err2)
	if len(cfg1.Entrypoint) != len(cfg2.Entrypoint) {
		t.Fatal("BuildContainerSpec must be a pure function: repeated calls with the same input must agree")
	}
	if hc1.Resources.Memory != hc2.Resources.Memory {
		t.Fatal("BuildContainerSpec must be deterministic")
	}
}

// --- helpers

func mustOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func hasSecurityOpt(opts []string, want string) bool {
	for _, o := range opts {
		if o == want {
			return true
		}
	}
	return false
}

func containsSubstr(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func TestBuildContainerSpec_BlkioWeightOnlyWhenNodeSupportsIt(t *testing.T) {
	node := testNode() // IOWeightSupported defaults to false
	_, hc, _, err := BuildContainerSpec(testServer(), node)
	mustOK(t, err)
	if hc.Resources.BlkioWeight != 0 {
		t.Fatalf("expected BlkioWeight=0 (unset) when the node hasn't confirmed IO-weight support, got %d", hc.Resources.BlkioWeight)
	}

	node.IOWeightSupported = true
	_, hc2, _, err := BuildContainerSpec(testServer(), node)
	mustOK(t, err)
	if hc2.Resources.BlkioWeight != 500 {
		t.Fatalf("expected default BlkioWeight=500 once the node opts in, got %d", hc2.Resources.BlkioWeight)
	}
}
