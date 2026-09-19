package main

import (
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/gxhost/agent/internal/spec"
)

func recoverWithLabels(t *testing.T, labels map[string]string) spec.Server {
	t.Helper()
	labels["gxhost.server.uuid"] = "server-1"
	labels["gxhost.server.uid"] = "100123"
	sv, err := recoveredServerSpec("example/java:25", []string{"java"}, []string{"-jar", "s.jar"}, "SIGTERM", labels, &container.HostConfig{})
	if err != nil {
		t.Fatal(err)
	}
	return sv
}

// O limite de disco é o único que o Docker não guarda (não há cgroup para
// ele num bind mount — quem impõe é o fsx), então ele viaja num label.
func TestRecoveredServerSpec_LeDiskMBDoLabel(t *testing.T) {
	sv := recoverWithLabels(t, map[string]string{"gxhost.limits.disk_mb": "10240"})
	if sv.Limits.DiskMB != 10240 {
		t.Fatalf("DiskMB do label não foi recuperado: %d", sv.Limits.DiskMB)
	}
}

// Container criado antes do label existir: 0 significa "desconhecido", e
// fsx.CheckQuota trata <=0 como sem limite. O placeholder de 1MB que
// existia antes fazia o oposto — recusava TODO upload num servidor
// adotado, porque 1MB é menor que qualquer uso real.
func TestRecoveredServerSpec_SemLabelNaoInventaLimite(t *testing.T) {
	sv := recoverWithLabels(t, map[string]string{})
	if sv.Limits.DiskMB != 0 {
		t.Fatalf("sem label o limite deve ficar 0 (desconhecido), veio %d", sv.Limits.DiskMB)
	}
}

func TestRecoveredServerSpec_LabelInvalidoNaoViraLimite(t *testing.T) {
	for _, valor := range []string{"abc", "-5", ""} {
		sv := recoverWithLabels(t, map[string]string{"gxhost.limits.disk_mb": valor})
		if sv.Limits.DiskMB != 0 {
			t.Fatalf("label %q deveria virar 0, veio %d", valor, sv.Limits.DiskMB)
		}
	}
}
