package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/docker/docker/pkg/stdcopy"

	"github.com/gxhost/agent/internal/diag"
	"github.com/gxhost/agent/internal/dockerx"
	"github.com/gxhost/agent/internal/spec"
)

const (
	diagnosticsBudget = 38 * time.Second // the panel's own agent-call timeout is 45s
	maxProbeTargets   = 8
	maxAllocationIPs  = 256
)

type diagnosticsResponse struct {
	AgentTime time.Time    `json:"agentTime"`
	Checks    []diag.Check `json:"checks"`
}

// handleDiagnostics answers "can this node actually run a customer's
// server right now?" from the inside: Docker reachable, every allocation IP
// still assigned to the host, no game container frozen with an unusable
// resolv.conf, and DNS+HTTPS working from a container isolated exactly like
// a game server. Each of these broke in production at least once while the
// heartbeat kept reporting the node as healthy.
func (s *Server) handleDiagnostics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	targets := splitParam(q.Get("targets"))
	if len(targets) > maxProbeTargets {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_TARGETS", fmt.Sprintf("at most %d targets", maxProbeTargets))
		return
	}
	for _, t := range targets {
		if !diag.ValidHostname(t) {
			writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_TARGETS", "invalid hostname: "+t)
			return
		}
	}
	ips := splitParam(q.Get("ips"))
	if len(ips) > maxAllocationIPs {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_IPS", fmt.Sprintf("at most %d ips", maxAllocationIPs))
		return
	}
	image := strings.TrimSpace(q.Get("image"))
	if strings.ContainsAny(image, " \t\n") {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_IMAGE", "invalid image reference")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), diagnosticsBudget)
	defer cancel()

	checks := []diag.Check{s.checkDocker(ctx), checkAllocationIPs(ips), s.checkContainerResolvConf(ctx)}
	if image != "" && len(targets) > 0 {
		checks = append(checks, s.runEgressProbe(ctx, image, targets)...)
	}
	writeJSONResp(w, http.StatusOK, diagnosticsResponse{AgentTime: time.Now().UTC(), Checks: checks})
}

func splitParam(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (s *Server) checkDocker(ctx context.Context) diag.Check {
	start := time.Now()
	v, err := s.dc.Version(ctx)
	c := diag.Check{Key: "docker", DurationMs: time.Since(start).Milliseconds()}
	if err != nil {
		c.Detail = err.Error()
		return c
	}
	c.OK, c.Detail = true, "Docker "+v
	return c
}

func checkAllocationIPs(ips []string) diag.Check {
	c := diag.Check{Key: "allocation_ips"}
	if len(ips) == 0 {
		c.OK, c.Detail = true, "nenhuma allocation cadastrada"
		return c
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		c.Detail = err.Error()
		return c
	}
	if missing := diag.MissingLocalIPs(ips, addrs); len(missing) > 0 {
		c.Detail = "IPs de allocation que o host não tem mais: " + diag.FormatList(missing, 5)
		return c
	}
	c.OK, c.Detail = true, "todos os IPs de allocation existem no host"
	return c
}

func (s *Server) checkContainerResolvConf(ctx context.Context) diag.Check {
	start := time.Now()
	c := diag.Check{Key: "container_dns_config"}
	list, err := s.dc.ListManaged(ctx)
	if err != nil {
		c.Detail = err.Error()
		return c
	}
	var broken []string
	checked := 0
	for _, ctr := range list {
		if ctr.Labels["gxhost.role"] != "" {
			continue
		}
		insp, err := s.dc.InspectContainer(ctx, ctr.ID)
		if err != nil || insp.ResolvConfPath == "" {
			continue
		}
		content, err := os.ReadFile(insp.ResolvConfPath)
		if err != nil {
			continue
		}
		checked++
		if ns := diag.BrokenNameserver(string(content)); ns != "" {
			broken = append(broken, fmt.Sprintf("%s (%s)", ctr.Labels[dockerx.ServerUUIDLabel], ns))
		}
	}
	c.DurationMs = time.Since(start).Milliseconds()
	if len(broken) > 0 {
		c.Detail = "servidores com DNS inutilizável (recriar o container resolve): " + diag.FormatList(broken, 5)
		return c
	}
	c.OK, c.Detail = true, fmt.Sprintf("%d container(s) com DNS válido", checked)
	return c
}

func (s *Server) runEgressProbe(ctx context.Context, image string, targets []string) []diag.Check {
	start := time.Now()
	fail := func(detail string) []diag.Check {
		return []diag.Check{{Key: "egress", Detail: detail, DurationMs: time.Since(start).Milliseconds()}}
	}

	if err := s.dc.PullPinned(ctx, image, ""); err != nil {
		return fail("não foi possível obter a imagem de teste: " + err.Error())
	}
	cmd := append([]string{"sh", "-c", diag.ProbeScript, "probe"}, targets...)
	cfg, hc, netCfg, err := spec.BuildProbeContainerSpec(s.node, image, cmd)
	if err != nil {
		return fail(err.Error())
	}

	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	id, err := s.dc.CreateContainer(ctx, "gxhost-probe-"+hex.EncodeToString(suffix), cfg, hc, netCfg)
	if err != nil {
		return fail("não foi possível criar o container de teste: " + err.Error())
	}
	defer func() { _ = s.dc.RemoveContainer(context.Background(), id, true) }()

	if err := s.dc.StartContainer(ctx, id); err != nil {
		return fail("não foi possível iniciar o container de teste: " + err.Error())
	}
	if _, err := s.dc.WaitContainer(ctx, id); err != nil {
		return fail("o container de teste não terminou a tempo: " + err.Error())
	}

	rc, err := s.dc.ContainerLogs(ctx, id, "all")
	if err != nil {
		return fail(err.Error())
	}
	defer rc.Close()
	var stdout, stderr bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdout, &stderr, rc); err != nil {
		return fail("lendo a saída do container de teste: " + err.Error())
	}

	checks := diag.ProbeChecks(targets, stdout.String())
	elapsed := time.Since(start).Milliseconds()
	for i := range checks {
		checks[i].DurationMs = elapsed
	}
	return checks
}
