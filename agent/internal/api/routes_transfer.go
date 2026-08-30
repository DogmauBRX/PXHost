package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strconv"
	"time"

	"github.com/pxhost/agent/internal/auth"
	"github.com/pxhost/agent/internal/panel"
	"github.com/pxhost/agent/internal/srv"
)

// handleTransferExport is the source node's half of a node-to-node
// transfer (architecture doc roadmap M13): packages the server's current
// data into a transfer-scoped archive (srv.Server.Export requires the
// server already stopped — see its doc comment for why a transfer, a
// one-way irreversible move, can't tolerate an in-flight write the way
// a point-in-time backup can). The archive is served to the TARGET node
// via handleTransferDownload below, exactly like a backup download —
// just a separate storage root (s.transfers, not s.backups) so it never
// shows up in the customer's own backup list.
func (s *Server) handleTransferExport(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	b, err := target.Export(r.Context(), s.transfers)
	if err != nil {
		writeBackupError(w, err)
		return
	}
	writeJSONResp(w, http.StatusCreated, b)
}

// handleTransferDownload is hit directly by the TARGET agent (not a
// browser) with a signed, single-use capability token the panel minted
// for exactly this archive — same posture as handleBackupsDownload, one
// capability (transfer.download) instead of backup.download.
func (s *Server) handleTransferDownload(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	archiveID := pathParam(r, "archiveId")
	token := r.URL.Query().Get("token")
	if _, err := s.verifier.VerifyFileToken(token, target.UUID, auth.CapTransferDownload, archiveID, s.fileTokenReplay); err != nil {
		writeErrorResp(w, http.StatusUnauthorized, "TOKEN_INVALID", err.Error())
		return
	}

	rc, size, err := s.transfers.Open(r.Context(), target.UUID, archiveID)
	if err != nil {
		writeBackupError(w, err)
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	_, _ = io.Copy(w, rc)
}

// handleTransferDeleteArchive removes a transfer's temp archive — called
// by the panel on whichever node still has a copy once a transfer
// resolves. Node-token-gated, not a capability token: this is
// panel-to-agent housekeeping, not something a browser ever touches.
func (s *Server) handleTransferDeleteArchive(w http.ResponseWriter, r *http.Request) {
	uuid := pathParam(r, "uuid")
	archiveID := pathParam(r, "archiveId")
	if err := s.transfers.Delete(r.Context(), uuid, archiveID); err != nil {
		writeBackupError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type importTransferRequest struct {
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
	TransferID      string            `json:"transferId"`
	ArchiveID       string            `json:"archiveId"`
	SourceURL       string            `json:"sourceUrl"`
	SourceToken     string            `json:"sourceToken"`
}

// handleTransferImport is the target node's half: registers the server
// under its ORIGINAL uuid (a transfer moves a server, it doesn't create
// a new one), fetches the source's archive over plain HTTP using the
// capability token the panel minted, extracts it, and builds the
// container — no install script runs, unlike handleCreateServer: the
// data (including whatever the original install already produced) IS
// the transferred content. Same "202 now, real answer later" shape as
// create+install, for the same reason: fetching and extracting a
// multi-gigabyte archive can run far longer than any request timeout
// should be set to.
func (s *Server) handleTransferImport(w http.ResponseWriter, r *http.Request) {
	var req importTransferRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}
	if req.UUID == "" || req.Image == "" || req.StartupTemplate == "" || req.SourceURL == "" || req.ArchiveID == "" {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", "uuid, image, startupTemplate, sourceUrl, and archiveId are required")
		return
	}

	sv, err := buildServerSpec(req.UUID, req.UID, req.Image, req.ImageDigest, req.StartupTemplate, req.StopSignal, req.DeclaredVars, req.Variables, req.Limits, req.Allocations)
	if err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_VARIABLES", err.Error())
		return
	}

	target, err := s.manager.Register(sv, s.node)
	if err != nil {
		writeErrorResp(w, http.StatusConflict, "SERVER_EXISTS", err.Error())
		return
	}

	if err := s.dc.PullPinned(r.Context(), sv.Image, req.ImageDigest); err != nil {
		s.manager.Remove(req.UUID)
		writeErrorResp(w, http.StatusBadGateway, "PULL_FAILED", err.Error())
		return
	}

	writeJSONResp(w, http.StatusAccepted, map[string]any{"uuid": req.UUID, "state": "restoring"})

	// The HTTP response above already went out; everything from here runs
	// on s.bgCtx (process-lifetime), not r.Context() — same reasoning as
	// runInstallAsync in routes_create_server.go.
	go s.runTransferImportAsync(target, req.TransferID, req.SourceURL, req.SourceToken, req.ArchiveID)
}

func (s *Server) runTransferImportAsync(target *srv.Server, transferID, sourceURL, sourceToken, archiveID string) {
	err := s.fetchAndRestoreTransfer(target, sourceURL, sourceToken, archiveID)
	successful := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
		s.log.Warn("transfer import failed", "server", target.UUID, "err", err)
	} else if createErr := target.Create(s.bgCtx, s.dc); createErr != nil {
		successful = false
		errMsg = createErr.Error()
		s.log.Warn("transfer import: container create failed", "server", target.UUID, "err", createErr)
	} else {
		s.log.Info("transfer import completed", "server", target.UUID)
	}

	if !successful {
		// Full cleanup, not just the in-memory registration: a failed
		// import can leave a container behind (Create succeeded, nothing
		// AFTER it did) or just an orphaned data directory (Create was
		// never reached at all) — either way, this node must not be left
		// holding a stopped, un-owned copy of a server that's about to be
		// reported as still living on the source node.
		_ = target.Remove(s.bgCtx, s.dc)
		s.manager.Remove(target.UUID)
		_ = os.RemoveAll(path.Join(s.node.DataDir, target.UUID))
	}

	if s.panel == nil {
		return
	}
	ctx, cancel := context.WithTimeout(s.bgCtx, 30*time.Second)
	defer cancel()
	if err := s.panel.TransferResult(ctx, s.tokenStore.Get(), panel.TransferResultRequest{
		TransferID:   transferID,
		Successful:   successful,
		ErrorMessage: errMsg,
	}); err != nil {
		s.log.Warn("failed to report transfer result to panel", "server", target.UUID, "err", err)
	}
}

// fetchAndRestoreTransfer does the actual byte-moving: GET the archive
// from the source node's signed download endpoint, land it locally under
// s.transfers (Provider.Put — see its doc comment for why this needs a
// dedicated method rather than reusing Create), then extract it directly
// into the freshly registered server's own jail. There's no "staging dir
// + atomic swap" step the way backup restore-into-an-EXISTING-server
// needs (internal/srv/backup.go's Restore): target.Jail was just opened
// on an empty directory by manager.Register, so extracting straight into
// it is already safe.
func (s *Server) fetchAndRestoreTransfer(target *srv.Server, sourceURL, sourceToken, archiveID string) error {
	fetchCtx, cancel := context.WithTimeout(s.bgCtx, 30*time.Minute)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, sourceURL+"?token="+sourceToken, nil)
	if err != nil {
		return fmt.Errorf("building fetch request: %w", err)
	}
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("fetching archive from source node: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("source node returned %d: %s", resp.StatusCode, string(body))
	}

	if _, err := s.transfers.Put(fetchCtx, target.UUID, archiveID, resp.Body); err != nil {
		return fmt.Errorf("saving fetched archive: %w", err)
	}
	if err := s.transfers.Restore(s.bgCtx, target.UUID, archiveID, target.Jail, target.UID()); err != nil {
		return fmt.Errorf("extracting archive: %w", err)
	}
	_ = s.transfers.Delete(s.bgCtx, target.UUID, archiveID) // best-effort local cleanup; the panel separately tells the SOURCE node to delete its own copy
	return nil
}
