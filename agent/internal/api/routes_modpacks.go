package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gxhost/agent/internal/backup"
	"github.com/gxhost/agent/internal/panel"
	"github.com/gxhost/agent/internal/srv"
)

type installModpackRequest struct {
	OperationID string `json:"operationId"`
	SourceURL   string `json:"sourceUrl"`
	Filename    string `json:"filename"`
	Size        int64  `json:"size"`
	SHA1        string `json:"sha1,omitempty"`
	SHA512      string `json:"sha512,omitempty"`
	DiskLimitMB int64  `json:"diskLimitMb"`
}

func (s *Server) handleModpackInstall(w http.ResponseWriter, r *http.Request) {
	target, ok := s.fileServerFromPath(w, r)
	if !ok {
		return
	}
	var req installModpackRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", err.Error())
		return
	}
	if req.OperationID == "" || req.SourceURL == "" || req.Size <= 0 {
		writeErrorResp(w, http.StatusUnprocessableEntity, "INVALID_BODY", "operationId, sourceUrl and size are required")
		return
	}
	if target.State != srv.StateOffline {
		writeErrorResp(w, http.StatusConflict, "SERVER_NOT_STOPPED", "server must be offline before installing a modpack")
		return
	}

	go s.runModpackInstall(target, req)
	writeJSONResp(w, http.StatusAccepted, map[string]interface{}{"operationId": req.OperationID, "status": "pending"})
}

func (s *Server) runModpackInstall(target *srv.Server, req installModpackRequest) {
	report := func(status string, progress int, message, backupID, errorMessage string) {
		if s.panel == nil {
			return
		}
		err := s.panel.ModpackProgress(s.bgCtx, s.tokenStore.Get(), target.UUID, panel.ModpackProgressRequest{
			OperationID: req.OperationID, Status: status, Progress: progress, Message: message,
			BackupID: backupID, ErrorMessage: errorMessage,
		})
		if err != nil {
			s.log.Error("reporting modpack progress", "operation", req.OperationID, "error", err)
		}
	}

	report("downloading", 5, "Criando backup de segurança", "", "")
	b, err := target.Backup(s.bgCtx, s.backups, backup.NewIgnoreSet())
	if err != nil {
		report("failed", 0, "Não foi possível criar o backup", "", err.Error())
		return
	}
	report("downloading", 10, "Baixando e validando o pacote", b.ID, "")
	err = target.InstallModpack(s.bgCtx, srv.ModpackInstallSpec{
		SourceURL: req.SourceURL, ExpectedSize: req.Size, SHA1: req.SHA1, SHA512: req.SHA512,
		DiskLimitMB: req.DiskLimitMB,
	}, func(progress int, message string) { report("installing", progress, message, b.ID, "") })
	if err == nil {
		report("configuring", 98, "Iniciando o servidor para validar a instalação", b.ID, "")
		err = target.Start(s.bgCtx, s.dc)
		if err == nil {
			report("completed", 100, "Modpack instalado e servidor iniciado", b.ID, "")
			return
		}
		_ = target.Kill(s.bgCtx, s.dc)
	}

	report("rolling_back", 95, "Falha detectada; restaurando o backup", b.ID, err.Error())
	restoreErr := target.Restore(s.bgCtx, s.backups, b.ID)
	if restoreErr != nil && !errors.Is(restoreErr, srv.ErrServerNotStopped) {
		report("failed", 100, "Falha na instalação e no rollback automático", b.ID, err.Error()+"; rollback: "+restoreErr.Error())
		return
	}
	report("failed", 100, "Instalação cancelada; arquivos anteriores restaurados", b.ID, err.Error())
}
