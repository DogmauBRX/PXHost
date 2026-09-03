package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"

	"github.com/pxhost/agent/internal/auth"
	"github.com/pxhost/agent/internal/fsx"
	"github.com/pxhost/agent/internal/srv"
)

// maxUploadBytes bounds any write this handler set will accept absent a
// narrower per-request limit (a capability token's ctx.maxBytes is
// always narrower still, for uploads). 5 GiB comfortably covers the
// roadmap's "2 GB upload works" DoD with headroom, without being
// effectively unbounded.
const maxUploadBytes = 5 << 30

func (s *Server) fileServerFromPath(w http.ResponseWriter, r *http.Request) (*srv.Server, bool) {
	uuid := pathParam(r, "uuid")
	target, ok := s.manager.Get(uuid)
	if !ok {
		writeErrorResp(w, http.StatusNotFound, "SERVER_NOT_FOUND", "no server registered with that uuid")
		return nil, false
	}
	return target, true
}

func writeFsxError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, fsx.ErrInvalidPath), errors.Is(err, fsx.ErrEscapesJail):
		writeErrorResp(w, http.StatusBadRequest, "INVALID_PATH", err.Error())
	case errors.Is(err, fsx.ErrQuotaExceeded):
		writeErrorResp(w, http.StatusConflict, "QUOTA_EXCEEDED", err.Error())
	case errors.Is(err, fsx.ErrArchiveBomb):
		writeErrorResp(w, http.StatusBadRequest, "ARCHIVE_REJECTED", err.Error())
	case os.IsNotExist(err):
		writeErrorResp(w, http.StatusNotFound, "NOT_FOUND", err.Error())
	default:
		writeErrorResp(w, http.StatusInternalServerError, "FILE_OP_FAILED", err.Error())
	}
}

func (s *Server) handleFilesList(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	entries, err := target.Jail.List(r.URL.Query().Get("path"))
	if err != nil {
		writeFsxError(w, err)
		return
	}
	writeJSONResp(w, http.StatusOK, entries)
}

func (s *Server) handleFilesRead(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	content, err := target.Jail.ReadFile(r.URL.Query().Get("path"))
	if err != nil {
		writeFsxError(w, err)
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{"content": string(content)})
}

func (s *Server) handleFilesWrite(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	path := r.URL.Query().Get("path")
	if err := target.Jail.CheckQuota(r.ContentLength, target.DiskLimitMB()); err != nil {
		writeFsxError(w, err)
		return
	}
	n, err := target.Jail.WriteFile(path, r.Body, target.UID(), maxUploadBytes)
	if err != nil {
		writeFsxError(w, err)
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{"bytesWritten": n})
}

// handleDiskUsage is the one place fsx.Jail.DiskUsageBytes ever gets
// exposed over HTTP (client account management era — see that function's
// own doc comment: it's a genuine recursive walk, "correctness over
// micro-optimizing," fine before one write but not something to run on
// every stats tick). Callers are expected to poll this on-demand — a
// button, not a live gauge — and cache the result client-side for a
// while; nothing here does that caching itself, this handler always
// measures fresh.
func (s *Server) handleDiskUsage(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	used, err := target.Jail.DiskUsageBytes()
	if err != nil {
		writeFsxError(w, err)
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{"usedBytes": used, "limitMb": target.DiskLimitMB()})
}

type renameRequest struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (s *Server) handleFilesRename(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	var req renameRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}
	if err := target.Jail.Rename(req.From, req.To); err != nil {
		writeFsxError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleFilesDelete(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	recursive, _ := strconv.ParseBool(r.URL.Query().Get("recursive"))
	if err := target.Jail.Remove(r.URL.Query().Get("path"), recursive); err != nil {
		writeFsxError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type mkdirRequest struct {
	Path string `json:"path"`
}

func (s *Server) handleFilesMkdir(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	var req mkdirRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}
	if err := target.Jail.Mkdir(req.Path, target.UID()); err != nil {
		writeFsxError(w, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

type chmodRequest struct {
	Path string `json:"path"`
	Mode uint32 `json:"mode"`
}

func (s *Server) handleFilesChmod(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	var req chmodRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}
	if err := target.Jail.Chmod(req.Path, req.Mode); err != nil {
		writeFsxError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type compressRequest struct {
	Paths []string `json:"paths"`
	Dest  string   `json:"dest"`
}

func (s *Server) handleFilesCompress(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	var req compressRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}
	if len(req.Paths) == 0 || req.Dest == "" {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", "paths and dest are required")
		return
	}
	if err := target.Jail.Compress(req.Paths, req.Dest, target.UID()); err != nil {
		writeFsxError(w, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

type decompressRequest struct {
	Path string `json:"path"`
	Dest string `json:"dest"`
}

func (s *Server) handleFilesDecompress(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	var req decompressRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}
	extracted, skipped, err := target.Jail.Decompress(req.Path, req.Dest, target.UID())
	if err != nil {
		writeFsxError(w, err)
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{"extracted": extracted, "skipped": skipped})
}

// handleFilesDownload is hit directly by the browser with a signed,
// single-use capability token — never the node's bearer token
// (architecture doc 3.4/4.4).
func (s *Server) handleFilesDownload(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	path := r.URL.Query().Get("path")
	token := r.URL.Query().Get("token")
	if _, err := s.verifier.VerifyFileToken(token, target.UUID, auth.CapFileDownload, path, s.fileTokenReplay); err != nil {
		writeErrorResp(w, http.StatusUnauthorized, "TOKEN_INVALID", err.Error())
		return
	}

	f, err := target.Jail.Open(path)
	if err != nil {
		writeFsxError(w, err)
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || stat.IsDir() {
		writeErrorResp(w, http.StatusBadRequest, "NOT_A_FILE", "path is a directory")
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", stat.Name()))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(stat.Size(), 10))
	_, _ = io.Copy(w, f)
}

// handleFilesUpload is hit directly by the browser with a signed,
// single-use capability token whose ctx.maxBytes bounds this specific
// upload (architecture doc 3.4) — narrower than maxUploadBytes, which is
// only the absolute outer ceiling.
func (s *Server) handleFilesUpload(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	path := r.URL.Query().Get("path")
	token := r.URL.Query().Get("token")
	claims, err := s.verifier.VerifyFileToken(token, target.UUID, auth.CapFileUpload, path, s.fileTokenReplay)
	if err != nil {
		writeErrorResp(w, http.StatusUnauthorized, "TOKEN_INVALID", err.Error())
		return
	}
	maxBytes := int64(maxUploadBytes)
	if claims.Ctx.MaxBytes > 0 && claims.Ctx.MaxBytes < maxBytes {
		maxBytes = claims.Ctx.MaxBytes
	}

	if err := target.Jail.CheckQuota(r.ContentLength, target.DiskLimitMB()); err != nil {
		writeFsxError(w, err)
		return
	}
	n, err := target.Jail.WriteFile(path, r.Body, target.UID(), maxBytes)
	if err != nil {
		writeFsxError(w, err)
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{"bytesWritten": n})
}
