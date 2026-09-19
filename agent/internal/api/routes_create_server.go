package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/gxhost/agent/internal/dockerx"
	"github.com/gxhost/agent/internal/panel"
	"github.com/gxhost/agent/internal/spec"
	"github.com/gxhost/agent/internal/srv"
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
	envMap, err := buildEnvMap(uuid, declaredVars, variables, primaryAllocationPort(allocations))
	if err != nil {
		return spec.Server{}, err
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
	digest := req.ImageDigest

	// A UUID the manager already knows is a RETRY of a request that got
	// at least as far as registering the container — either THIS attempt
	// or an earlier one already ran Create() successfully, and only the
	// separate, async Install() step failed afterward (a PullPinned/
	// Create failure below un-registers itself via manager.Remove, so
	// reaching here with an existing registration specifically means an
	// install failure, never a dispatch failure). Found live:
	// ServerSetupService.complete's own "Tentar novamente" — the exact
	// case this whole endpoint exists to support — used to 409
	// SERVER_EXISTS here every time, which the panel's dispatchToAgent
	// folds into a silent "success" (the correct call for a genuinely
	// lost-in-flight duplicate request, wrong here): nothing was ever
	// reinstalled, so the row was stuck reporting "installing" forever
	// with no callback ever coming. Reinstall's own remove-then-recreate
	// mechanism handles a retry with a DIFFERENT template/image/startup
	// just as well as a plain "try the exact same thing again."
	if target, ok := s.manager.Get(req.UUID); ok {
		if err := s.dc.PullPinned(r.Context(), image, digest); err != nil {
			writeErrorResp(w, http.StatusBadGateway, "PULL_FAILED", err.Error())
			return
		}
		if err := target.Reinstall(r.Context(), s.dc, image, req.StartupTemplate, req.StopSignal, sv.Env); err != nil {
			if errors.Is(err, srv.ErrServerNotStopped) {
				writeErrorResp(w, http.StatusConflict, "SERVER_NOT_STOPPED", err.Error())
				return
			}
			writeErrorResp(w, http.StatusBadGateway, "REINSTALL_FAILED", err.Error())
			return
		}
		writeJSONResp(w, http.StatusAccepted, map[string]any{"uuid": req.UUID, "state": "installing"})
		go s.runInstallAsync(target, req.InstallImage, req.InstallEntry, req.InstallScript)
		return
	}

	target, err := s.manager.Register(sv, s.node)
	if err != nil {
		// Still a real 409: this only fires when Register's OWN guard
		// races against the manager.Get check above (two concurrent
		// requests for a UUID neither has seen yet) — genuinely "someone
		// else's request already claimed this," not a retry.
		writeErrorResp(w, http.StatusConflict, "SERVER_EXISTS", err.Error())
		return
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
	go s.runInstallAsync(target, req.InstallImage, req.InstallEntry, req.InstallScript)
}

func (s *Server) runInstallAsync(target *srv.Server, image, entrypoint, script string) {
	s.reportInstallOutcome(target, target.Install(s.bgCtx, s.dc, image, entrypoint, script, 15*time.Minute))
}

// reportInstallOutcome tells the panel how an install ended — nil for
// success. Split out of runInstallAsync so the steps that run BEFORE the
// install script (pulling the image, recreating the container during a
// reinstall) can report a failure through the same callback: the server
// is sitting at `installing` in the panel from the moment the 202 goes
// out, and only this call moves it off that status. Failing silently
// would leave it stuck on "Preparando" forever.
func (s *Server) reportInstallOutcome(target *srv.Server, err error) {
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

// reinstallRequest mirrors the panel's ReinstallAgentServerRequest
// (apps/api/src/modules/nodes/agent-client.service.ts). Deliberately
// narrower than createServerRequest: a version change never touches
// uid/limits/allocations, and the already-registered *srv.Server keeps
// those from its original Create.
type reinstallRequest struct {
	UUID            string            `json:"uuid"`
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

// handleReinstallServer swaps a registered server's software in place —
// the agent half of the panel's "Trocar versão".
//
// createServer can never be reused for this: the manager's Register
// guard 409s on a UUID it already knows, which is precisely the normal
// case for a server old enough to have a version worth changing. Found
// live: the panel and the API both shipped this feature, but the agent
// route they call never existed, so every attempt came back as Go's bare
// "404 page not found" from the mux.
func (s *Server) handleReinstallServer(w http.ResponseWriter, r *http.Request) {
	uuid := pathParam(r, "uuid")
	var req reinstallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}
	if req.Image == "" || req.StartupTemplate == "" {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", "image and startupTemplate are required")
		return
	}

	target, ok := s.manager.Get(uuid)
	if !ok {
		writeErrorResp(w, http.StatusNotFound, "SERVER_NOT_FOUND", "no server registered with that uuid")
		return
	}
	if target.State != srv.StateOffline {
		writeErrorResp(w, http.StatusConflict, "SERVER_RUNNING", "server must be stopped before changing its version")
		return
	}

	// SERVER_PORT has to survive the rebuild: it is injected from the
	// primary allocation, which a reinstall never resends (see
	// reinstallRequest) — the registered server is the only thing that
	// still knows it. Dropping it here would write server-port=25565
	// into server.properties on the next install, which is the exact
	// "connection refused on every allocation but one" bug buildEnvMap's
	// own doc comment describes.
	envMap, err := buildEnvMap(uuid, req.DeclaredVars, req.Variables, target.PrimaryPort())
	if err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_VARIABLES", err.Error())
		return
	}

	image := req.Image
	if req.ImageDigest != "" {
		image = image + "@" + req.ImageDigest
	}

	writeJSONResp(w, http.StatusAccepted, map[string]any{"uuid": uuid, "state": "installing"})

	// EVERYTHING heavy happens after the response, on s.bgCtx — never on
	// r.Context(). Found live: pulling the image inside the request blew
	// past AgentClient's 45s timeout the first time a version change
	// needed an image the node didn't have yet (a cold java_17). The
	// panel aborted, which cancelled r.Context() mid-CreateContainer:
	// Docker went ahead and created the container while the SDK returned
	// a cancellation error, so the agent never recorded the id and ended
	// up with a server whose container existed but was unknown to it —
	// "has no container to start; call Create first" on the next action,
	// with no way out except re-adopting at boot.
	go func() {
		if err := s.dc.PullPinned(s.bgCtx, image, req.ImageDigest); err != nil {
			s.reportInstallOutcome(target, fmt.Errorf("pulling %s: %w", image, err))
			return
		}
		if err := target.Reinstall(s.bgCtx, s.dc, image, req.StartupTemplate, req.StopSignal, envMap); err != nil {
			s.reportInstallOutcome(target, err)
			return
		}
		s.runInstallAsync(target, req.InstallImage, req.InstallEntry, req.InstallScript)
	}()
}

func (s *Server) handleDeleteServer(w http.ResponseWriter, r *http.Request) {
	uuid := pathParam(r, "uuid")
	target, ok := s.manager.Get(uuid)
	if !ok {
		// manager is in-memory only — a server created live through
		// handleCreateServer is never persisted to disk, so an agent
		// restart drops every server it knew about from this map while
		// their containers keep running untouched. The panel's
		// AgentClient.deleteServer treats a 404 here as an idempotent
		// no-op (the legitimate case is an install that failed before
		// Register ever ran, so there truly is no container) and hard-
		// deletes the server row regardless of which case this was.
		// Found live: that made a bare "not registered" answer wrong
		// whenever it was actually the restart case — the container
		// survived, permanently orphaned with nothing left pointing at
		// it. Docker's own label is the only remaining source of truth
		// at that point, so it gets one direct check before this
		// answers "truly nothing here".
		removed, err := s.removeUnregisteredContainer(r.Context(), uuid)
		if err != nil {
			writeErrorResp(w, http.StatusBadGateway, "REMOVE_FAILED", err.Error())
			return
		}
		if !removed {
			writeErrorResp(w, http.StatusNotFound, "SERVER_NOT_FOUND", "no server registered with that uuid")
			return
		}
		w.WriteHeader(http.StatusNoContent)
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

// findContainerByUUID returns the id/running-state of the first container
// in list carrying dockerx.ServerUUIDLabel == uuid. Split out from
// removeUnregisteredContainer's Docker calls so the matching logic can be
// unit tested without a real daemon (dockerx.Client is a concrete wrapper
// with no fake-able seam — see srv package's test files for the same
// pattern/reasoning).
func findContainerByUUID(list []container.Summary, uuid string) (id string, running bool, found bool) {
	for _, c := range list {
		if c.Labels[dockerx.ServerUUIDLabel] == uuid {
			return c.ID, c.State == "running", true
		}
	}
	return "", false, false
}

// removeUnregisteredContainer force-tears-down a managed container by its
// gxhost.server.uuid label, bypassing the manager entirely. Used only when
// the manager has no handle for the requested uuid (see handleDeleteServer)
// — the container's Docker-reported state is checked directly since there
// is no in-memory srv.Server for it here.
func (s *Server) removeUnregisteredContainer(ctx context.Context, uuid string) (bool, error) {
	list, err := s.dc.ListManaged(ctx)
	if err != nil {
		return false, fmt.Errorf("listing managed containers: %w", err)
	}
	id, running, found := findContainerByUUID(list, uuid)
	if !found {
		return false, nil
	}
	if running {
		if err := s.dc.KillContainer(ctx, id); err != nil {
			return false, fmt.Errorf("killing orphaned container %s: %w", id, err)
		}
	}
	if err := s.dc.RemoveContainer(ctx, id, true); err != nil {
		return false, fmt.Errorf("removing orphaned container %s: %w", id, err)
	}
	s.log.Warn("removed a container the manager had no record of (agent restart lost its registration)", "uuid", uuid, "container", id)
	return true, nil
}

// primaryAllocationPort returns the primary allocation's port, or 0 if
// none is marked primary (buildServerSpec's caller always sends one, but
// this stays defensive rather than panicking on malformed input — the
// same reasoning as every other best-effort default in this file).
func primaryAllocationPort(allocations []agentAllocation) int {
	for _, a := range allocations {
		if a.Primary {
			return a.Port
		}
	}
	return 0
}

// buildEnvMap turns the panel-supplied declared/variables pair into the
// final env map, injecting the same reserved keys (SERVER_UUID, HOME,
// USER, TZ, LANG, TERM, SERVER_PORT) every server gets regardless of its
// template — shared by both a fresh create and a variables-only recreate
// (routes_server.go's handleUpdateVariables) so the two paths can never
// drift on what "the environment" means for a server.
//
// SERVER_PORT matters more than it looks: hostconfig.go's
// buildPortBindings deliberately maps host port == container port
// (never Docker-level NAT remapping — game protocols embed the port in
// their own responses, which NAT-style remapping breaks). That only
// works if the game process INSIDE the container actually listens on
// that same port — nothing else tells it to. Every install script
// writes this into its software's own port-config file (server.properties
// for Minecraft) before the software's first launch; skipping this
// silently "worked" for exactly one port per node (whichever happened to
// match the software's own hardcoded default) and refused connections
// on every other allocation.
func buildEnvMap(uuid string, declaredVars []string, variables map[string]string, primaryPort int) (map[string]string, error) {
	env, _, err := spec.BuildEnv(declaredVars, variables, map[string]string{
		"SERVER_UUID": uuid,
		"HOME":        "/home/container",
		"USER":        "container",
		"TZ":          "UTC",
		"LANG":        "C.UTF-8",
		"TERM":        "xterm",
		"SERVER_PORT": strconv.Itoa(primaryPort),
	})
	if err != nil {
		return nil, err
	}
	envMap := make(map[string]string, len(env))
	for _, kv := range env {
		k, v := splitEnvKV(kv)
		envMap[k] = v
	}
	return envMap, nil
}

func splitEnvKV(kv string) (string, string) {
	for i := 0; i < len(kv); i++ {
		if kv[i] == '=' {
			return kv[:i], kv[i+1:]
		}
	}
	return kv, ""
}
