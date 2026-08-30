package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/pxhost/agent/internal/auth"
	"github.com/pxhost/agent/internal/spec"
	"github.com/pxhost/agent/internal/srv"
)

const filesTestNodeUUID = "node-files-test"
const filesTestServerUUID = "9c2e0000-0000-0000-0000-0000000000f1"

func newFilesTestServer(t *testing.T) (*Server, ed25519.PrivateKey) {
	t.Helper()
	dataDir := t.TempDir()
	node := spec.Node{
		DataDir:     dataDir,
		BackupDir:   t.TempDir(),
		UIDRangeMin: 1,
		UIDRangeMax: 999999,
	}
	sv := spec.Server{
		UUID: filesTestServerUUID,
		UID:  1000,
		Limits: spec.Limits{
			MemoryMB: 512,
			DiskMB:   0, // unlimited for most tests; specific quota tests override via CheckQuota directly
		},
	}
	manager := srv.NewManager()
	if _, err := manager.Register(sv, node); err != nil {
		t.Fatalf("Register: %v", err)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	verifier := auth.NewTokenVerifier(pub, filesTestNodeUUID, 5*time.Second)

	s := New(Config{
		Manager:   manager,
		Verifier:  verifier,
		Node:      node,
		NodeUUID:  filesTestNodeUUID,
		TokenStore: NewTokenStore("test-node-token"),
	})
	return s, priv
}

func doReq(t *testing.T, s *Server, method, target string, body []byte, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	return rec
}

func TestFilesRoutes_WriteThenReadRoundTrips(t *testing.T) {
	s, _ := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/files"

	wr := doReq(t, s, http.MethodPut, base+"/contents?path=server.properties", []byte("motd=hi"), "test-node-token")
	if wr.Code != http.StatusOK {
		t.Fatalf("write status = %d, body=%s", wr.Code, wr.Body.String())
	}

	rr := doReq(t, s, http.MethodGet, base+"/contents?path=server.properties", nil, "test-node-token")
	if rr.Code != http.StatusOK {
		t.Fatalf("read status = %d, body=%s", rr.Code, rr.Body.String())
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Content != "motd=hi" {
		t.Fatalf("content = %q, want %q", body.Content, "motd=hi")
	}
}

func TestFilesRoutes_ListReflectsWrites(t *testing.T) {
	s, _ := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/files"
	doReq(t, s, http.MethodPut, base+"/contents?path=a.txt", []byte("x"), "test-node-token")

	lr := doReq(t, s, http.MethodGet, base+"/list?path=.", nil, "test-node-token")
	if lr.Code != http.StatusOK {
		t.Fatalf("list status = %d, body=%s", lr.Code, lr.Body.String())
	}
	var entries []map[string]any
	if err := json.Unmarshal(lr.Body.Bytes(), &entries); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(entries) != 1 || entries[0]["name"] != "a.txt" {
		t.Fatalf("expected exactly [a.txt], got %v", entries)
	}
}

func TestFilesRoutes_PathTraversalRejected(t *testing.T) {
	s, _ := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/files"

	wr := doReq(t, s, http.MethodPut, base+"/contents?path=../../../../etc/pwned", []byte("x"), "test-node-token")
	if wr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a \"..\" path, got %d: %s", wr.Code, wr.Body.String())
	}
}

func TestFilesRoutes_RequireNodeTokenOnSmallOps(t *testing.T) {
	s, _ := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/files"

	rr := doReq(t, s, http.MethodGet, base+"/list?path=.", nil, "") // no bearer at all
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with no node token, got %d", rr.Code)
	}
	rr = doReq(t, s, http.MethodGet, base+"/list?path=.", nil, "wrong-token")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with a wrong node token, got %d", rr.Code)
	}
}

func mintTestFileToken(t *testing.T, priv ed25519.PrivateKey, cap auth.Capability, path string, maxBytes int64) string {
	t.Helper()
	claims := &auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{"node:" + filesTestNodeUUID},
			Subject:   filesTestServerUUID,
			ID:        "file-token-" + path + "-" + string(cap),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
		UID: "user-1",
		Cap: cap,
		Ctx: &auth.TokenContext{Path: path, MaxBytes: maxBytes},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	s, err := tok.SignedString(priv)
	if err != nil {
		t.Fatalf("signing test token: %v", err)
	}
	return s
}

func TestFilesRoutes_DownloadWithSignedTokenIsSingleUse(t *testing.T) {
	s, priv := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/files"
	doReq(t, s, http.MethodPut, base+"/contents?path=world.dat", []byte("game data"), "test-node-token")

	tok := mintTestFileToken(t, priv, auth.CapFileDownload, "world.dat", 0)

	first := doReq(t, s, http.MethodGet, base+"/download?path=world.dat&token="+tok, nil, "")
	if first.Code != http.StatusOK {
		t.Fatalf("first download status = %d, body=%s", first.Code, first.Body.String())
	}
	if first.Body.String() != "game data" {
		t.Fatalf("downloaded content = %q, want %q", first.Body.String(), "game data")
	}

	second := doReq(t, s, http.MethodGet, base+"/download?path=world.dat&token="+tok, nil, "")
	if second.Code != http.StatusUnauthorized {
		t.Fatalf("expected the SAME token reused to be rejected (single-use), got %d", second.Code)
	}
}

func TestFilesRoutes_DownloadTokenRejectsWrongPath(t *testing.T) {
	s, priv := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/files"
	doReq(t, s, http.MethodPut, base+"/contents?path=a.txt", []byte("A"), "test-node-token")
	doReq(t, s, http.MethodPut, base+"/contents?path=b.txt", []byte("B"), "test-node-token")

	tok := mintTestFileToken(t, priv, auth.CapFileDownload, "a.txt", 0)
	rr := doReq(t, s, http.MethodGet, base+"/download?path=b.txt&token="+tok, nil, "")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected a token minted for a.txt to be rejected against b.txt, got %d", rr.Code)
	}
}

func TestFilesRoutes_UploadWithSignedTokenWritesFile(t *testing.T) {
	s, priv := newFilesTestServer(t)
	base := "/api/servers/" + filesTestServerUUID + "/files"

	tok := mintTestFileToken(t, priv, auth.CapFileUpload, "uploaded.txt", 1<<20)
	ur := doReq(t, s, http.MethodPost, base+"/upload?path=uploaded.txt&token="+tok, []byte("uploaded content"), "")
	if ur.Code != http.StatusOK {
		t.Fatalf("upload status = %d, body=%s", ur.Code, ur.Body.String())
	}

	rr := doReq(t, s, http.MethodGet, base+"/contents?path=uploaded.txt", nil, "test-node-token")
	var body struct {
		Content string `json:"content"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body.Content != "uploaded content" {
		t.Fatalf("uploaded file content = %q", body.Content)
	}
}
