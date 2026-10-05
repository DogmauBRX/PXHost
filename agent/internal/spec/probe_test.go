package spec

import "testing"

func TestBuildProbeContainerSpec_MatchesGameContainerIsolation(t *testing.T) {
	node := testNode()
	cfg, hc, netCfg, err := BuildProbeContainerSpec(node, "ghcr.io/pterodactyl/yolks:java_21", []string{"sh", "-c", "true"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(hc.NetworkMode) != node.NetworkName || netCfg.EndpointsConfig[node.NetworkName] == nil {
		t.Fatalf("probe must join the node bridge network like a game container, got %q", hc.NetworkMode)
	}
	if !hc.ReadonlyRootfs || len(hc.CapDrop) != 1 || hc.CapDrop[0] != "ALL" || len(hc.CapAdd) != 0 || hc.Privileged {
		t.Fatalf("probe must run with the game container's hardening: %+v", hc)
	}
	if cfg.User == "" || cfg.User[0] == '0' {
		t.Fatalf("probe must run unprivileged, got user %q", cfg.User)
	}
	if _, managed := cfg.Labels["gxhost.managed"]; managed {
		t.Fatal("probe must not carry gxhost.managed: boot reconciliation would adopt it as a server")
	}
	if hc.Resources.Memory <= 0 || hc.Resources.PidsLimit == nil {
		t.Fatal("probe must be resource-bounded")
	}
}

func TestBuildProbeContainerSpec_RejectsMissingConfig(t *testing.T) {
	node := testNode()
	if _, _, _, err := BuildProbeContainerSpec(node, "", nil); err == nil {
		t.Fatal("expected an error for an empty image")
	}
	node.NetworkName = ""
	if _, _, _, err := BuildProbeContainerSpec(node, "img", nil); err == nil {
		t.Fatal("expected an error for a node without a network")
	}
}
