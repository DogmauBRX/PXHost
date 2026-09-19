package main

import (
	"reflect"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/go-connections/nat"
)

func TestRecoveredServerSpecPreservesIdentityLimitsAndAllocations(t *testing.T) {
	pids := int64(512)
	hc := &container.HostConfig{
		Resources: container.Resources{
			Memory: 2 * 1024 * 1024 * 1024, MemorySwap: 3 * 1024 * 1024 * 1024,
			CPUPeriod: 100000, CPUQuota: 250000, BlkioWeight: 500, PidsLimit: &pids,
		},
		PortBindings: nat.PortMap{
			"25565/tcp": {{HostIP: "192.0.2.10", HostPort: "25565"}},
			"25565/udp": {{HostIP: "192.0.2.10", HostPort: "25565"}},
		},
	}

	sv, err := recoveredServerSpec(
		"example/java:21", []string{"java", "-Xmx2048M"}, []string{"-jar", "server file.jar"}, "SIGTERM",
		map[string]string{"gxhost.server.uuid": "server-1", "gxhost.server.uid": "100123"}, hc,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sv.UUID != "server-1" || sv.UID != 100123 || sv.Image != "example/java:21" {
		t.Fatalf("identity not recovered: %#v", sv)
	}
	if sv.Limits.MemoryMB != 2048 || sv.Limits.SwapMB != 1024 || sv.Limits.CPUPercent != 250 || sv.Limits.PidsLimit != 512 {
		t.Fatalf("limits not recovered: %#v", sv.Limits)
	}
	if sv.StartupTmpl != "java -Xmx2048M -jar 'server file.jar'" {
		t.Fatalf("startup command not safely recovered: %q", sv.StartupTmpl)
	}
	if len(sv.Allocations) != 1 || !sv.Allocations[0].Primary || sv.Allocations[0].IP != "192.0.2.10" || sv.Allocations[0].Port != 25565 || !reflect.DeepEqual(sv.Allocations[0].Protocols, []string{"tcp", "udp"}) {
		t.Fatalf("allocation not recovered: %#v", sv.Allocations)
	}
}

func TestRecoveredServerSpecRejectsMissingUID(t *testing.T) {
	_, err := recoveredServerSpec("image", []string{"java"}, nil, "", map[string]string{"gxhost.server.uuid": "server-1"}, &container.HostConfig{})
	if err == nil {
		t.Fatal("expected missing uid label to be rejected")
	}
}
