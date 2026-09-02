package api

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/pxhost/agent/internal/auth"
	"github.com/pxhost/agent/internal/backup"
	"github.com/pxhost/agent/internal/dockerx"
	"github.com/pxhost/agent/internal/panel"
	"github.com/pxhost/agent/internal/spec"
	"github.com/pxhost/agent/internal/srv"
)

// Server is the agent's HTTP + WebSocket control surface.
type Server struct {
	manager   *srv.Manager
	dc        *dockerx.Client
	verifier  *auth.TokenVerifier
	node       spec.Node // node-local config, needed to register/create servers dynamically (M5)
	nodeUUID   string
	tokenStore *TokenStore // hot-swappable — see tokenstore.go; rotation (M13) updates this, not a plain field
	panel      *panel.Client // nil if node.json has no panel_url (standalone mode); install-completion callbacks are skipped, not fatal
	// bgCtx is the process-lifetime context (cancelled on SIGINT/SIGTERM,
	// never per-request) that async work — specifically Install() and its
	// panel callback — runs on, for exactly the reason documented on
	// srv.Server.Start: a request-scoped context dies with the request
	// that triggered the work, but installing a Minecraft server
	// legitimately outlives the HTTP call that kicked it off.
	bgCtx context.Context
	log   *slog.Logger

	// wsOriginPatterns restricts which browser Origins may open the
	// console/stats WebSocket. Left permissive ("*") only for the M2 CLI/
	// local-dev smoke test; a real deployment must set this to the panel's
	// exact origin(s) — an unrestricted Origin check on a WS upgrade is a
	// cross-site hijacking hole (architecture doc 4.5 requires the agent
	// to check Origin against the configured panel origin).
	wsOriginPatterns []string

	// fileTokenReplay burns single-use file.download/file.upload/
	// backup.download capability tokens (architecture doc 3.4) — shared
	// across every request, since a token's jti must never be honored
	// twice regardless of which server or resource it was minted for.
	fileTokenReplay *auth.ReplayCache

	backups backup.Provider

	// transfers is a SEPARATE backup.Provider instance rooted at
	// node.TransferDir, not node.BackupDir — same LocalProvider shape
	// (architecture doc roadmap M13 reuses backup's archive/restore
	// primitives wholesale rather than inventing a second format), but a
	// different root so a transfer's temp archive never shows up in a
	// customer's own backup list (LocalProvider.List enumerates every
	// *.json sidecar under a server's directory with no way to filter by
	// "who created this").
	transfers backup.Provider

	httpServer *http.Server
}

type Config struct {
	Manager          *srv.Manager
	Docker           *dockerx.Client
	Verifier         *auth.TokenVerifier
	Node             spec.Node
	NodeUUID         string
	TokenStore       *TokenStore // shared secret for REST calls, both directions — see tokenstore.go
	PanelURL         string // empty = standalone mode, no install-completion callbacks
	BgCtx            context.Context
	WSOriginPatterns []string
	Logger           *slog.Logger
}

func New(cfg Config) *Server {
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	origins := cfg.WSOriginPatterns
	if len(origins) == 0 {
		origins = []string{"*"}
	}
	bgCtx := cfg.BgCtx
	if bgCtx == nil {
		bgCtx = context.Background()
	}
	var panelClient *panel.Client
	if cfg.PanelURL != "" {
		panelClient = panel.New(cfg.PanelURL)
	}
	s := &Server{
		manager:          cfg.Manager,
		dc:               cfg.Docker,
		verifier:         cfg.Verifier,
		node:             cfg.Node,
		nodeUUID:         cfg.NodeUUID,
		tokenStore:       cfg.TokenStore,
		panel:            panelClient,
		bgCtx:            bgCtx,
		log:              log,
		wsOriginPatterns: origins,
		fileTokenReplay:  auth.NewReplayCache(),
		backups:          backup.NewLocalProvider(cfg.Node.BackupDir),
		transfers:        backup.NewLocalProvider(cfg.Node.TransferDir),
	}
	s.httpServer = &http.Server{
		Handler: s.routes(),
		// Explicit timeouts everywhere: a Go http.Server with no timeouts
		// is the classic Slowloris footgun, and this is a control-plane
		// endpoint sitting on every hosting node (architecture doc 8,
		// SEC-87 in the QA plan).
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// WriteTimeout is intentionally left at 0 (unbounded): the WS
		// handler and any future long-poll/stream response legitimately
		// stay open far longer than a normal request. Idle/read timeouts
		// plus SetReadLimit on the socket are the real bound here.
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 32 * 1024,
	}
	return s
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.handleHealthz)

	mux.Handle("POST /api/servers", s.requireNodeToken(http.HandlerFunc(s.handleCreateServer)))
	mux.Handle("GET /api/servers/{uuid}", s.requireNodeToken(http.HandlerFunc(s.handleGetServer)))
	mux.Handle("DELETE /api/servers/{uuid}", s.requireNodeToken(http.HandlerFunc(s.handleDeleteServer)))
	mux.Handle("POST /api/servers/{uuid}/power", s.requireNodeToken(http.HandlerFunc(s.handlePower)))
	mux.Handle("PATCH /api/servers/{uuid}/limits", s.requireNodeToken(http.HandlerFunc(s.handleUpdateLimits)))
	mux.Handle("PATCH /api/servers/{uuid}/suspend", s.requireNodeToken(http.HandlerFunc(s.handleSuspend)))
	mux.Handle("PATCH /api/servers/{uuid}/variables", s.requireNodeToken(http.HandlerFunc(s.handleUpdateVariables)))

	// The WS endpoint is NOT gated by requireNodeToken: per architecture
	// doc 4.5, its authentication is the panel-signed capability token
	// sent as the connection's first frame, verified offline. Requiring
	// the node's machine-to-machine bearer token here as well would mean
	// the browser would need it too, which defeats the entire point of
	// short-lived, narrowly-scoped browser capability tokens.
	mux.HandleFunc("GET /api/servers/{uuid}/ws", s.wsHandler)

	// File "small ops" (architecture doc 3.2/4.4) — panel-to-agent, same
	// node-token gate as power actions. Every one of these resolves its
	// path through srv.Server.Jail; none of them ever touches os.Open
	// with a bare string.
	mux.Handle("GET /api/servers/{uuid}/files/list", s.requireNodeToken(http.HandlerFunc(s.handleFilesList)))
	mux.Handle("GET /api/servers/{uuid}/files/contents", s.requireNodeToken(http.HandlerFunc(s.handleFilesRead)))
	mux.Handle("PUT /api/servers/{uuid}/files/contents", s.requireNodeToken(http.HandlerFunc(s.handleFilesWrite)))
	mux.Handle("POST /api/servers/{uuid}/files/rename", s.requireNodeToken(http.HandlerFunc(s.handleFilesRename)))
	mux.Handle("DELETE /api/servers/{uuid}/files", s.requireNodeToken(http.HandlerFunc(s.handleFilesDelete)))
	mux.Handle("POST /api/servers/{uuid}/files/mkdir", s.requireNodeToken(http.HandlerFunc(s.handleFilesMkdir)))
	mux.Handle("POST /api/servers/{uuid}/files/chmod", s.requireNodeToken(http.HandlerFunc(s.handleFilesChmod)))
	mux.Handle("POST /api/servers/{uuid}/files/compress", s.requireNodeToken(http.HandlerFunc(s.handleFilesCompress)))
	mux.Handle("POST /api/servers/{uuid}/files/decompress", s.requireNodeToken(http.HandlerFunc(s.handleFilesDecompress)))

	// Signed-URL transfers (architecture doc 3.4/4.4) — the BROWSER hits
	// these directly, same reasoning as the console WS: a short-lived,
	// single-use Ed25519 capability token IS the authentication, not the
	// node's machine-to-machine bearer. Wrapped in CORS: unlike the WS
	// upgrade (which has its own Origin check baked into the handshake),
	// a plain fetch() POST from the panel's origin to the agent's own
	// origin needs explicit CORS headers, or the browser blocks the
	// response from ever reaching the panel's JS — download works without
	// this too (a plain navigation/download isn't subject to CORS at
	// all), but upload's fetch() call to read back {bytesWritten} does not.
	mux.Handle("GET /api/servers/{uuid}/files/download", s.corsForBrowser(http.HandlerFunc(s.handleFilesDownload)))
	mux.Handle("POST /api/servers/{uuid}/files/upload", s.corsForBrowser(http.HandlerFunc(s.handleFilesUpload)))
	mux.Handle("OPTIONS /api/servers/{uuid}/files/upload", s.corsForBrowser(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })))

	// Backups (architecture doc 3.2/4.5) — same two-tier pattern as
	// files: small ops node-token-gated, download a signed URL the
	// browser hits directly.
	mux.Handle("GET /api/servers/{uuid}/backups", s.requireNodeToken(http.HandlerFunc(s.handleBackupsList)))
	mux.Handle("POST /api/servers/{uuid}/backups", s.requireNodeToken(http.HandlerFunc(s.handleBackupsCreate)))
	mux.Handle("DELETE /api/servers/{uuid}/backups/{backupId}", s.requireNodeToken(http.HandlerFunc(s.handleBackupsDelete)))
	mux.Handle("POST /api/servers/{uuid}/backups/{backupId}/restore", s.requireNodeToken(http.HandlerFunc(s.handleBackupsRestore)))
	mux.Handle("GET /api/servers/{uuid}/backups/{backupId}/download", s.corsForBrowser(http.HandlerFunc(s.handleBackupsDownload)))

	// Node-to-node transfer (architecture doc roadmap M13). Export/import/
	// delete are node-token-gated panel-to-agent calls, same tier as
	// power/backups; download is hit by the TARGET agent's own HTTP
	// client (not a browser, so no CORS wrapper needed) with a signed
	// transfer.download capability token, same posture as backup download.
	mux.Handle("POST /api/servers/{uuid}/transfer/export", s.requireNodeToken(http.HandlerFunc(s.handleTransferExport)))
	mux.Handle("GET /api/servers/{uuid}/transfer/archive/{archiveId}/download", http.HandlerFunc(s.handleTransferDownload))
	mux.Handle("DELETE /api/servers/{uuid}/transfer/archive/{archiveId}", s.requireNodeToken(http.HandlerFunc(s.handleTransferDeleteArchive)))
	mux.Handle("POST /api/servers/transfer/import", s.requireNodeToken(http.HandlerFunc(s.handleTransferImport)))

	return mux
}

func (s *Server) ListenAndServe(addr string) error {
	s.httpServer.Addr = addr
	s.log.Info("agent api listening", "addr", addr)
	return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.httpServer.Shutdown(ctx)
}

func pathParam(r *http.Request, name string) string {
	return r.PathValue(name)
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSONResp(w, http.StatusOK, map[string]any{"status": "ok", "node": s.nodeUUID})
}

// localAddrHint is used only for the CLI's own log line when starting the
// server; kept here rather than in cmd/pxagent to avoid duplicating the
// "what does 0.0.0.0 mean" formatting logic.
func localAddrHint(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "localhost"
	}
	return net.JoinHostPort(host, port)
}
