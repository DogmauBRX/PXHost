package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gxhost/agent/internal/spec"
	"github.com/gxhost/agent/internal/srv"
)

func (s *Server) handleGetServer(w http.ResponseWriter, r *http.Request) {
	uuid := pathParam(r, "uuid")
	target, ok := s.manager.Get(uuid)
	if !ok {
		writeErrorResp(w, http.StatusNotFound, "SERVER_NOT_FOUND", "no server registered with that uuid")
		return
	}

	resp := map[string]any{
		"uuid":               target.UUID,
		"state":              string(target.State),
		"containerId":        target.ContainerID,
		"memoryLimitMb":      target.MemoryLimitMB(),
		"cpuLimitPercent":    target.CPULimitPercent(),
		"consoleSubscribers": target.Hub.SubscriberCount(),
	}
	if frame, ok := target.LatestStats(); ok {
		resp["stats"] = frame
	}
	writeJSONResp(w, http.StatusOK, resp)
}

type powerRequest struct {
	Action string `json:"action"`
}

func (s *Server) handlePower(w http.ResponseWriter, r *http.Request) {
	uuid := pathParam(r, "uuid")
	target, ok := s.manager.Get(uuid)
	if !ok {
		writeErrorResp(w, http.StatusNotFound, "SERVER_NOT_FOUND", "no server registered with that uuid")
		return
	}

	var req powerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}

	prev := string(target.State)
	if err := performPower(r.Context(), s.dc, target, req.Action); err != nil {
		writeErrorResp(w, http.StatusConflict, "POWER_ACTION_FAILED", err.Error())
		return
	}

	writeJSONResp(w, http.StatusAccepted, map[string]any{
		"state":    string(target.State),
		"previous": prev,
	})
}

// updateLimitsRequest mirrors spec.Limits field-for-field — a plain
// struct rather than reusing spec.Limits directly so the wire format
// (camelCase JSON, panel-facing) stays decoupled from the Go struct's
// own field names, the same reasoning every other request/response type
// in this package already follows.
type updateLimitsRequest struct {
	CPUPercent int   `json:"cpuPercent"`
	MemoryMB   int64 `json:"memoryMb"`
	SwapMB     int64 `json:"swapMb"`
	DiskMB     int64 `json:"diskMb"`
	IOWeight   int   `json:"ioWeight"`
	PidsLimit  int64 `json:"pidsLimit"`
}

// handleUpdateLimits is the live half of plan-apply (architecture doc
// roadmap M12): pushes a changed plan's limits onto an already-running
// server via Docker's live ContainerUpdate — see srv.Server.UpdateLimits
// and dockerx.Client.UpdateContainer's doc comments for why this never
// needs a recreate or restart.
func (s *Server) handleUpdateLimits(w http.ResponseWriter, r *http.Request) {
	uuid := pathParam(r, "uuid")
	target, ok := s.manager.Get(uuid)
	if !ok {
		writeErrorResp(w, http.StatusNotFound, "SERVER_NOT_FOUND", "no server registered with that uuid")
		return
	}

	var req updateLimitsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}

	newLimits := spec.Limits{
		CPUPercent: req.CPUPercent,
		MemoryMB:   req.MemoryMB,
		SwapMB:     req.SwapMB,
		DiskMB:     req.DiskMB,
		IOWeight:   req.IOWeight,
		PidsLimit:  req.PidsLimit,
	}
	if err := target.UpdateLimits(r.Context(), s.dc, newLimits); err != nil {
		writeErrorResp(w, http.StatusBadGateway, "UPDATE_LIMITS_FAILED", err.Error())
		return
	}

	writeJSONResp(w, http.StatusOK, map[string]any{"updated": true})
}

type suspendRequest struct {
	Suspended bool `json:"suspended"`
}

// handleSuspend is the agent's half of architecture doc roadmap M14's
// two independent suspension enforcement points — see
// srv.Server.SetSuspended's doc comment for why suspending force-kills
// a running container rather than waiting for a graceful stop.
func (s *Server) handleSuspend(w http.ResponseWriter, r *http.Request) {
	uuid := pathParam(r, "uuid")
	target, ok := s.manager.Get(uuid)
	if !ok {
		writeErrorResp(w, http.StatusNotFound, "SERVER_NOT_FOUND", "no server registered with that uuid")
		return
	}

	var req suspendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}

	if err := target.SetSuspended(r.Context(), s.dc, req.Suspended); err != nil {
		writeErrorResp(w, http.StatusBadGateway, "SUSPEND_FAILED", err.Error())
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{"suspended": req.Suspended, "state": string(target.State)})
}

type updateVariablesRequest struct {
	DeclaredVars []string          `json:"declaredVariables"`
	Variables    map[string]string `json:"variables"`
}

// handleUpdateVariables is the agent's half of the panel's Configurações
// tab (Fase 7 of the client-features plan): Docker env is immutable after
// a container is created, so applying an edited variable means removing
// and recreating the container — see srv.Server.UpdateVariables's doc
// comment for why that's safe (the data directory, jail, and this
// Server's identity in the manager are untouched) and why it refuses a
// running server outright rather than trying to reconcile a live swap.
func (s *Server) handleUpdateVariables(w http.ResponseWriter, r *http.Request) {
	uuid := pathParam(r, "uuid")
	target, ok := s.manager.Get(uuid)
	if !ok {
		writeErrorResp(w, http.StatusNotFound, "SERVER_NOT_FOUND", "no server registered with that uuid")
		return
	}

	var req updateVariablesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}

	env, err := buildEnvMap(uuid, req.DeclaredVars, req.Variables, target.PrimaryPort())
	if err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_VARIABLES", err.Error())
		return
	}

	if err := target.UpdateVariables(r.Context(), s.dc, env); err != nil {
		writeErrorResp(w, http.StatusConflict, "UPDATE_VARIABLES_FAILED", err.Error())
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{"updated": true})
}

// reinstallRequest carries only what a version change can actually alter —
// unlike createServerRequest, never uid/allocations/limits, which stay
// exactly as the already-registered *srv.Server has them.
type reinstallRequest struct {
	Image           string            `json:"image"`
	ImageDigest     string            `json:"imageDigest,omitempty"`
	StartupTemplate string            `json:"startupTemplate"`
	StopSignal      string            `json:"stopSignal,omitempty"`
	DeclaredVars    []string          `json:"declaredVariables"`
	Variables       map[string]string `json:"variables"`
	InstallImage    string            `json:"installImage"`
	InstallEntry    string            `json:"installEntrypoint"`
	InstallScript   string            `json:"installScript"`
}

// handleReinstallServer is the agent's half of the panel's "Trocar Versão"
// (ServerSetupService.changeVersion): swaps an already-`ready` server's
// image/startup command/variables and re-runs the install script against
// its EXISTING registration — see srv.Server.Reinstall's doc comment for
// why this can never reuse handleCreateServer's manager.Register path.
// Same "pull, then mutate, then install in the background" shape as
// handleCreateServer, minus the Register call.
func (s *Server) handleReinstallServer(w http.ResponseWriter, r *http.Request) {
	uuid := pathParam(r, "uuid")
	target, ok := s.manager.Get(uuid)
	if !ok {
		writeErrorResp(w, http.StatusNotFound, "SERVER_NOT_FOUND", "no server registered with that uuid")
		return
	}

	var req reinstallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}
	if req.Image == "" || req.StartupTemplate == "" {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", "image and startupTemplate are required")
		return
	}

	env, err := buildEnvMap(uuid, req.DeclaredVars, req.Variables, target.PrimaryPort())
	if err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_VARIABLES", err.Error())
		return
	}

	image := req.Image
	if req.ImageDigest != "" {
		image = image + "@" + req.ImageDigest
	}
	if err := s.dc.PullPinned(r.Context(), image, req.ImageDigest); err != nil {
		writeErrorResp(w, http.StatusBadGateway, "PULL_FAILED", err.Error())
		return
	}

	if err := target.Reinstall(r.Context(), s.dc, image, req.StartupTemplate, req.StopSignal, env); err != nil {
		if errors.Is(err, srv.ErrServerNotStopped) {
			writeErrorResp(w, http.StatusConflict, "SERVER_NOT_STOPPED", err.Error())
			return
		}
		writeErrorResp(w, http.StatusBadGateway, "REINSTALL_FAILED", err.Error())
		return
	}

	writeJSONResp(w, http.StatusAccepted, map[string]any{"uuid": uuid, "state": "installing"})

	// Same post-response, background install as handleCreateServer — see
	// that handler's own comment on why this runs on s.bgCtx via
	// runInstallAsync, not r.Context().
	installImage := req.InstallImage
	installEntry := req.InstallEntry
	installScript := req.InstallScript
	go s.runInstallAsync(target, installImage, installEntry, installScript)
}

func writeJSONResp(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErrorResp(w http.ResponseWriter, status int, code, message string) {
	writeJSONResp(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": message},
	})
}
