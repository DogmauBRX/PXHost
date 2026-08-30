package spec

import "testing"

func testInstallSpec() InstallSpec {
	return InstallSpec{Image: "ghcr.io/pxhost/installers:debian", Entrypoint: "bash", ScriptHostPath: "/var/lib/pxhost/install/9c2e.../install.sh"}
}

func TestBuildInstallContainerSpec_ArgvIsConstantTwoElements(t *testing.T) {
	cfg, _, _, err := BuildInstallContainerSpec(testServer(), testNode(), testInstallSpec())
	mustOK(t, err)
	want := []string{"bash", "/mnt/install/install.sh"}
	if !equalSlices([]string(cfg.Entrypoint), want) {
		t.Fatalf("expected constant argv %v, got %v", want, cfg.Entrypoint)
	}
}

func TestBuildInstallContainerSpec_StillNeverPrivilegedNeverHostNetwork(t *testing.T) {
	_, hc, _, err := BuildInstallContainerSpec(testServer(), testNode(), testInstallSpec())
	mustOK(t, err)
	if hc.Privileged {
		t.Fatal("install container must never be privileged")
	}
	if hc.NetworkMode.IsHost() {
		t.Fatal("install container must never use host networking")
	}
	if len(hc.CapDrop) != 1 || hc.CapDrop[0] != "ALL" {
		t.Fatalf("expected CapDrop=[ALL], got %v", hc.CapDrop)
	}
	if len(hc.CapAdd) != 0 {
		t.Fatalf("expected no added capabilities, got %v", hc.CapAdd)
	}
	if !hasSecurityOpt(hc.SecurityOpt, "no-new-privileges:true") {
		t.Fatal("expected no-new-privileges:true")
	}
}

func TestBuildInstallContainerSpec_RootfsIsWritable(t *testing.T) {
	_, hc, _, err := BuildInstallContainerSpec(testServer(), testNode(), testInstallSpec())
	mustOK(t, err)
	if hc.ReadonlyRootfs {
		t.Fatal("install container rootfs must be writable (installers need /tmp and package caches)")
	}
}

func TestBuildInstallContainerSpec_LogCompressionDisabledForSingleFile(t *testing.T) {
	// Regression: the "local" log driver defaults compress=true, which
	// Docker's daemon rejects outright when max-file=1 ("compression
	// cannot be enabled when max file count is 1") — found live, the
	// install container failed to even start.
	_, hc, _, err := BuildInstallContainerSpec(testServer(), testNode(), testInstallSpec())
	mustOK(t, err)
	if hc.LogConfig.Config["max-file"] != "1" {
		t.Fatalf("expected max-file=1, got %q", hc.LogConfig.Config["max-file"])
	}
	if hc.LogConfig.Config["compress"] != "false" {
		t.Fatalf("expected compress=false alongside max-file=1, got %q", hc.LogConfig.Config["compress"])
	}
}

func TestBuildInstallContainerSpec_MemoryClampedToInstallCeilingRegardlessOfPlan(t *testing.T) {
	srv := testServer()
	srv.Limits.MemoryMB = 16384 // a big plan must NOT let the installer use 16GB
	_, hc, _, err := BuildInstallContainerSpec(srv, testNode(), testInstallSpec())
	mustOK(t, err)
	want := int64(installMemoryCeilingMB) * 1024 * 1024
	if hc.Resources.Memory != want {
		t.Fatalf("expected memory clamped to install ceiling %d, got %d", want, hc.Resources.Memory)
	}
}

func TestBuildInstallContainerSpec_TinyPlanMemoryPassesThroughUnclamped(t *testing.T) {
	// validateServer (shared with the real game-container spec) already
	// rejects MemoryMB <= 0 upstream, so the installer can never actually
	// see a zero-memory plan — this checks the other edge instead: a
	// small but valid plan (1 MB) isn't accidentally rounded up to the
	// install ceiling or down to zero by the clamp.
	srv := testServer()
	srv.Limits.MemoryMB = 1
	_, hc, _, err := BuildInstallContainerSpec(srv, testNode(), testInstallSpec())
	mustOK(t, err)
	want := int64(1024 * 1024)
	if hc.Resources.Memory != want {
		t.Fatalf("expected memory=%d for a 1MB plan, got %d", want, hc.Resources.Memory)
	}
}

func TestBuildInstallContainerSpec_MountsDataAtMntServerReadWriteAndScriptReadOnly(t *testing.T) {
	_, hc, _, err := BuildInstallContainerSpec(testServer(), testNode(), testInstallSpec())
	mustOK(t, err)
	if len(hc.Mounts) != 2 {
		t.Fatalf("expected exactly 2 mounts (data + script), got %d: %+v", len(hc.Mounts), hc.Mounts)
	}
	var sawData, sawScript bool
	for _, m := range hc.Mounts {
		switch m.Target {
		case "/mnt/server":
			sawData = true
			if m.ReadOnly {
				t.Fatal("data mount must be read-write for the installer to write server files")
			}
		case "/mnt/install/install.sh":
			sawScript = true
			if !m.ReadOnly {
				t.Fatal("install script mount must be read-only")
			}
		}
	}
	if !sawData || !sawScript {
		t.Fatalf("expected both /mnt/server and /mnt/install/install.sh mounts, got %+v", hc.Mounts)
	}
}

func TestBuildInstallContainerSpec_RejectsMissingInstallFields(t *testing.T) {
	cases := []InstallSpec{
		{Entrypoint: "bash", ScriptHostPath: "/x"},
		{Image: "img", ScriptHostPath: "/x"},
		{Image: "img", Entrypoint: "bash"},
	}
	for _, c := range cases {
		if _, _, _, err := BuildInstallContainerSpec(testServer(), testNode(), c); err == nil {
			t.Fatalf("expected an error for incomplete InstallSpec %+v", c)
		}
	}
}

func TestBuildInstallContainerSpec_LabelsIdentifyItAsAnInstaller(t *testing.T) {
	cfg, _, _, err := BuildInstallContainerSpec(testServer(), testNode(), testInstallSpec())
	mustOK(t, err)
	if cfg.Labels["pxhost.role"] != "installer" {
		t.Fatalf("expected pxhost.role=installer label, got %q", cfg.Labels["pxhost.role"])
	}
	if cfg.Labels["pxhost.managed"] != "true" {
		t.Fatal("expected pxhost.managed=true so boot reconciliation and cleanup can find installer containers too")
	}
}
