package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/pxhost/agent/internal/panel"
	"github.com/pxhost/agent/internal/spec"
	"github.com/pxhost/agent/internal/srv"
)

// createServerRequest mirrors the panel's CreateAgentServerRequest
// (apps/api/src/modules/nodes/agent-client.service.ts) — the wire
// contract between AgentClient and this handler (architecture doc M5:
// "the create transaction ... install job dispatched to the agent").
type createServerRequest struct {
	UUID            string            `json:"uuid"`
	UID             int               `json:"uid"`
	Image           string            `json:"image"`
	ImageDigest     string            `json:"imageDigest,omitempty"`
	StartupTemplate string            `json:"startupTemplate"`
	StopSignal      string            `json:"stopSignal,omitempty"`
	DeclaredVars    []string          `json:"declaredVariables"`
	Variables       map[string]string `json:"variables"`
	Limits          agentLimits       `json:"limits"`
	Allocations     []agentAllocation `json:"allocations"`
	InstallImage    string            `json:"installImage"`
	InstallEntry    string            `json:"installEntrypoint"`
	InstallScript   string            `json:"installScript"`
}

type agentLimits struct {
	CPUPercent int   `json:"cpuPercent"`
	MemoryMB   int64 `json:"memoryMb"`
	SwapMB     int64 `json:"swapMb"`
	DiskMB     int64 `json:"diskMb"`
	IOWeight   int   `json:"ioWeight"`
	PidsLimit  int64 `json:"pidsLimit"`
}

type agentAllocation struct {
	IP        string   `json:"ip"`
	Port      int      `json:"port"`
	Primary   bool     `json:"primary"`
	Protocols []string `json:"protocols,omitempty"`
}

// buildServerSpec turns the wire request shape shared by createServerRequest
// and importTransferRequest (routes_transfer.go) into a spec.Server —
// factored out because a node-to-node transfer's target side needs
// exactly this same env/limits/allocations translation with none of
// handleCreateServer's install-specific fields.
func buildServerSpec(uuid string, uid int, image, imageDigest, startupTemplate, stopSignal string, declaredVars []string, variables map[string]string, limits agentLimits, allocations []agentAllocation) (spec.Server, error) {
	env, _, err := spec.BuildEnv(declaredVars, variables, map[string]string{
		"SERVER_UUID": uuid,
		"HOME":        "/home/container",
		"USER":        "container",
		"TZ":          "UTC",
		"LANG":        "C.UTF-8",
		"TERM":        "xterm",
	})
	if err != nil {
		return spec.Server{}, err
	}
	envMap := make(map[string]string, len(env))
	for _, kv := range env {
		k, v := splitEnvKV(kv)
		envMap[k] = v
	}

	fullImage := image
	if imageDigest != "" {
		fullImage = image + "@" + imageDigest
	}

	allocs := make([]spec.Allocation, 0, len(allocations))
	for _, a := range allocations {
		allocs = append(allocs, spec.Allocation{IP: a.IP, Port: a.Port, Primary: a.Primary, Protocols: a.Protocols})
	}

	return spec.Server{
		UUID:        uuid,
		UID:         uid,
		Image:       fullImage,
		StartupTmpl: startupTemplate,
		StopSignal:  stopSignal,
		Env:         envMap,
		Limits: spec.Limits{
			CPUPercent: limits.CPUPercent,
			MemoryMB:   limits.MemoryMB,
			SwapMB:     limits.SwapMB,
			DiskMB:     limits.DiskMB,
			IOWeight:   limits.IOWeight,
			PidsLimit:  limits.PidsLimit,
		},
		Allocations: allocs,
	}, nil
}

func (s *Server) handleCreateServer(w http.ResponseWriter, r *http.Request) {
	var req createServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}
	if req.UUID == "" || req.Image == "" || req.StartupTemplate == "" {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", "uuid, image, and startupTemplate are required")
		return
	}

	sv, err := buildServerSpec(req.UUID, req.UID, req.Image, req.ImageDigest, req.StartupTemplate, req.StopSignal, req.DeclaredVars, req.Variables, req.Limits, req.Allocations)
	if err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_VARIABLES", err.Error())
		return
	}
	image := sv.Image

	target, err := s.manager.Register(sv, s.node)
	if err != nil {
		writeErrorResp(w, http.StatusConflict, "SERVER_EXISTS", err.Error())
		return
	}

	digest := ""
	if req.ImageDigest != "" {
		digest = req.ImageDigest
	}
	if err := s.dc.PullPinned(r.Context(), image, digest); err != nil {
		s.manager.Remove(req.UUID)
		writeErrorResp(w, http.StatusBadGateway, "PULL_FAILED", err.Error())
		return
	}
	if err := target.Create(r.Context(), s.dc); err != nil {
		s.manager.Remove(req.UUID)
		writeErrorResp(w, http.StatusBadGateway, "CREATE_FAILED", err.Error())
		return
	}

	writeJSONResp(w, http.StatusAccepted, map[string]any{"uuid": req.UUID, "state": "installing"})

	// The HTTP response above already went out; everything from here runs
	// on s.bgCtx (process-lifetime), not r.Context() (dead the moment this
	// handler returns) — see the doc comment on Server.bgCtx.
	installImage := req.InstallImage
	installEntry := req.InstallEntry
	installScript := req.InstallScript
	go s.runInstallAsync(target, installImage, installEntry, installScript)
}

func (s *Server) runInstallAsync(target *srv.Server, image, entrypoint, script string) {
	err := target.Install(s.bgCtx, s.dc, image, entrypoint, script, 15*time.Minute)
	successful := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
		s.log.Warn("install failed", "server", target.UUID, "err", err)
	} else {
		s.log.Info("install completed", "server", target.UUID)
	}

	if s.panel == nil {
		return // standalone mode (no panel_url configured) — nothing to call back to
	}
	ctx, cancel := context.WithTimeout(s.bgCtx, 30*time.Second)
	defer cancel()
	if err := s.panel.InstallCompleted(ctx, s.tokenStore.Get(), target.UUID, panel.InstallCompletedRequest{
		Successful:   successful,
		ErrorMessage: errMsg,
	}); err != nil {
		s.log.Warn("failed to report install result to panel", "server", target.UUID, "err", err)
	}
}

func (s *Server) handleDeleteServer(w http.ResponseWriter, r *http.Request) {
	uuid := pathParam(r, "uuid")
	target, ok := s.manager.Get(uuid)
	if !ok {
		writeErrorResp(w, http.StatusNotFound, "SERVER_NOT_FOUND", "no server registered with that uuid")
		return
	}
	if target.State != srv.StateOffline {
		if err := target.Kill(r.Context(), s.dc); err != nil {
			writeErrorResp(w, http.StatusBadGateway, "KILL_FAILED", err.Error())
			return
		}
	}
	if err := target.Remove(r.Context(), s.dc); err != nil {
		writeErrorResp(w, http.StatusBadGateway, "REMOVE_FAILED", err.Error())
		return
	}
	s.manager.Remove(uuid)
	w.WriteHeader(http.StatusNoContent)
}

func splitEnvKV(kv string) (string, string) {
	for i := 0; i < len(kv); i++ {
		if kv[i] == '=' {
			return kv[:i], kv[i+1:]
		}
	}
	return kv, ""
}
