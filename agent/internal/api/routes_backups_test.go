package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/pxhost/agent/internal/auth"
	"github.com/pxhost/agent/internal/backup"
	"github.com/pxhost/agent/internal/srv"
)

func TestBackupsRoutes_CreateListDownloadRoundTrip(t *testing.T) {
	s, priv := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/backups"

	doReq(t, s, http.MethodPut, "/api/servers/"+filesTestServerUUID+"/files/contents?path=world.dat", []byte("world contents"), "test-node-token")

	cr := doReq(t, s, http.MethodPost, base, nil, "test-node-token")
	if cr.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", cr.Code, cr.Body.String())
	}
	var created backup.Backup
	if err := json.Unmarshal(cr.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if created.SHA256 == "" {
		t.Fatal("expected a non-empty checksum on the created backup")
	}

	lr := doReq(t, s, http.MethodGet, base, nil, "test-node-token")
	var list []backup.Backup
	if err := json.Unmarshal(lr.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	if len(list) != 1 || list[0].ID != created.ID {
		t.Fatalf("List = %+v, want exactly [%s]", list, created.ID)
	}

	tok := mintTestFileToken(t, priv, auth.CapBackupDownload, created.ID, 0)
	dr := doReq(t, s, http.MethodGet, base+"/"+created.ID+"/download?token="+tok, nil, "")
	if dr.Code != http.StatusOK {
		t.Fatalf("download status = %d, body=%s", dr.Code, dr.Body.String())
	}
	if dr.Body.Len() == 0 {
		t.Fatal("expected a non-empty archive body")
	}

	second := doReq(t, s, http.MethodGet, base+"/"+created.ID+"/download?token="+tok, nil, "")
	if second.Code != http.StatusUnauthorized {
		t.Fatalf("expected a reused backup download token to be rejected (single-use), got %d", second.Code)
	}
}

func TestBackupsRoutes_DeleteRemovesIt(t *testing.T) {
	s, _ := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/backups"

	cr := doReq(t, s, http.MethodPost, base, nil, "test-node-token")
	var created backup.Backup
	_ = json.Unmarshal(cr.Body.Bytes(), &created)

	dr := doReq(t, s, http.MethodDelete, base+"/"+created.ID, nil, "test-node-token")
	if dr.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body=%s", dr.Code, dr.Body.String())
	}
	lr := doReq(t, s, http.MethodGet, base, nil, "test-node-token")
	var list []backup.Backup
	_ = json.Unmarshal(lr.Body.Bytes(), &list)
	if len(list) != 0 {
		t.Fatalf("expected an empty list after delete, got %+v", list)
	}
}

func TestBackupsRoutes_RestoreRejectedWhileServerRunning(t *testing.T) {
	s, _ := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/backups"

	cr := doReq(t, s, http.MethodPost, base, nil, "test-node-token")
	var created backup.Backup
	_ = json.Unmarshal(cr.Body.Bytes(), &created)

	target, _ := s.manager.Get(filesTestServerUUID)
	target.State = srv.StateRunning

	rr := doReq(t, s, http.MethodPost, base+"/"+created.ID+"/restore", nil, "test-node-token")
	if rr.Code != http.StatusConflict {
		t.Fatalf("expected 409 restoring a running server, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestBackupsRoutes_RequireNodeTokenOnSmallOps(t *testing.T) {
	s, _ := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/backups"

	rr := doReq(t, s, http.MethodGet, base, nil, "")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with no node token, got %d", rr.Code)
	}
}
