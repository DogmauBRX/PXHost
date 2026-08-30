package api

import (
	"encoding/json"
	"net/http"

	"github.com/pxhost/agent/internal/spec"
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
