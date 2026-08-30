package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/pxhost/agent/internal/auth"
	"github.com/pxhost/agent/internal/backup"
	"github.com/pxhost/agent/internal/srv"
)

func writeBackupError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, backup.ErrNotFound):
		writeErrorResp(w, http.StatusNotFound, "BACKUP_NOT_FOUND", err.Error())
	case errors.Is(err, backup.ErrInvalidArchive), errors.Is(err, backup.ErrArchiveTooLarge):
		writeErrorResp(w, http.StatusBadRequest, "BACKUP_REJECTED", err.Error())
	case errors.Is(err, srv.ErrServerNotStopped):
		writeErrorResp(w, http.StatusConflict, "SERVER_NOT_STOPPED", err.Error())
	default:
		writeErrorResp(w, http.StatusInternalServerError, "BACKUP_OP_FAILED", err.Error())
	}
}

func (s *Server) handleBackupsList(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	list, err := s.backups.List(r.Context(), target.UUID)
	if err != nil {
		writeBackupError(w, err)
		return
	}
	writeJSONResp(w, http.StatusOK, list)
}

type createBackupRequest struct {
	IgnorePatterns []string `json:"ignorePatterns"`
}

func (s *Server) handleBackupsCreate(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	var req createBackupRequest
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
			return
		}
	}
	ignore := backup.NewIgnoreSet(req.IgnorePatterns...)
	b, err := target.Backup(r.Context(), s.backups, ignore)
	if err != nil {
		writeBackupError(w, err)
		return
	}
	writeJSONResp(w, http.StatusCreated, b)
}

func (s *Server) handleBackupsDelete(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	if err := s.backups.Delete(r.Context(), target.UUID, pathParam(r, "backupId")); err != nil {
		writeBackupError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleBackupsRestore(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	if err := target.Restore(r.Context(), s.backups, pathParam(r, "backupId")); err != nil {
		writeBackupError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleBackupsDownload is hit directly by the browser with a signed,
// single-use capability token — never the node's bearer token
// (architecture doc 3.4/4.5, same posture as file downloads).
func (s *Server) handleBackupsDownload(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	backupID := pathParam(r, "backupId")
	token := r.URL.Query().Get("token")
	if _, err := s.verifier.VerifyFileToken(token, target.UUID, auth.CapBackupDownload, backupID, s.fileTokenReplay); err != nil {
		writeErrorResp(w, http.StatusUnauthorized, "TOKEN_INVALID", err.Error())
		return
	}

	rc, size, err := s.backups.Open(r.Context(), target.UUID, backupID)
	if err != nil {
		writeBackupError(w, err)
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", backupID+".tar.gz"))
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	_, _ = io.Copy(w, rc)
}
