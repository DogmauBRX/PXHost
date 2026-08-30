package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/pxhost/agent/internal/auth"
	"github.com/pxhost/agent/internal/console"
	"github.com/pxhost/agent/internal/dockerx"
	"github.com/pxhost/agent/internal/panel"
	"github.com/pxhost/agent/internal/srv"
)

var (
	errNotAuthFrame              = errors.New("api: first frame was not an auth event")
	errMissingBaselinePermission = errors.New("api: token lacks the websocket.connect permission")
)

const (
	authTimeout       = 10 * time.Second
	statsPushInterval = 2 * time.Second
	tokenExpiryWarn   = 60 * time.Second
)

// wsHandler serves GET /api/servers/{uuid}/ws — the browser's direct
// connection for console + stats (architecture doc 4.5). The HTTP upgrade
// itself requires no credential; per the documented protocol, the first
// frame the client must send is {"event":"auth","data":{"token":...}},
// and everything before a successful auth is otherwise inert.
func (s *Server) wsHandler(w http.ResponseWriter, r *http.Request) {
	serverUUID := pathParam(r, "uuid")

	target, ok := s.manager.Get(serverUUID)
	if !ok {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: s.wsOriginPatterns,
	})
	if err != nil {
		return // Accept already wrote the HTTP error
	}
	conn.SetReadLimit(64 * 1024)

	sess := &wsSession{
		conn:        conn,
		server:      target,
		verifier:    s.verifier,
		limiter:     console.NewRateLimiter(),
		log:         s.log.With("server", serverUUID),
		dc:          s.dc,
		panelClient: s.panel,
		tokenStore:  s.tokenStore,
		bgCtx:       s.bgCtx,
	}
	sess.run(r.Context())
}

// wsSession holds the per-connection state for one browser<->agent
// console/stats socket.
type wsSession struct {
	conn     *websocket.Conn
	server   *srv.Server
	verifier *auth.TokenVerifier
	limiter  *console.RateLimiter
	log      *slog.Logger
	dc       *dockerx.Client

	// panelClient/tokenStore/bgCtx exist ONLY so a successful power action
	// can report itself to the panel's activity feed (architecture doc
	// roadmap M11) — nil-safe (panelClient is nil in standalone mode,
	// same as everywhere else that checks it) and never on the critical
	// path of the power action itself. tokenStore, not a captured string,
	// so a token rotated (roadmap M13) mid-connection on a long-lived
	// console socket still reports with a valid token.
	panelClient *panel.Client
	tokenStore  *TokenStore
	bgCtx       context.Context

	claims *auth.Claims
}

func (sess *wsSession) run(parentCtx context.Context) {
	ctx, cancel := context.WithCancel(parentCtx)
	defer cancel()
	defer sess.conn.CloseNow()

	claims, err := sess.authenticate(ctx)
	if err != nil {
		sess.log.Warn("ws auth failed", "err", err)
		sess.conn.Close(StatusAuthFailed, "authentication failed")
		return
	}
	sess.claims = claims
	sess.log.Info("ws authenticated", "user", claims.UID, "permissions", claims.Permissions)

	// Architecture doc 2.5's gating table: suspension blocks control.*,
	// which the console IS — checked here rather than only relying on
	// the panel to never mint a token for a suspended server, so a token
	// minted moments before a suspension (or one still valid from before
	// it) can't be used to sneak a connection in afterward.
	if sess.server.Suspended() {
		sess.log.Info("ws rejected: server is suspended", "user", claims.UID)
		sess.conn.Close(StatusServerSuspended, "server is suspended")
		return
	}

	if err := sess.sendAuthOK(ctx); err != nil {
		return
	}
	sess.replayScrollback(ctx)

	sub := sess.server.Hub.Subscribe()
	defer sess.server.Hub.Unsubscribe(sub)

	expiryTimer := time.NewTimer(time.Until(claims.ExpiresAt.Time) - tokenExpiryWarn)
	defer expiryTimer.Stop()
	hardExpiry := time.NewTimer(time.Until(claims.ExpiresAt.Time))
	defer hardExpiry.Stop()

	statsTicker := time.NewTicker(statsPushInterval)
	defer statsTicker.Stop()

	readCh := make(chan Envelope)
	readErrCh := make(chan error, 1)
	go sess.readLoop(ctx, readCh, readErrCh)

	for {
		select {
		case <-ctx.Done():
			return

		case err := <-readErrCh:
			if err != nil {
				sess.log.Debug("ws read loop ended", "err", err)
			}
			return

		case env := <-readCh:
			if !sess.handleInbound(ctx, env) {
				return
			}

		case line := <-sub.C():
			dropped := sub.TakeDropped()
			if dropped > 0 {
				_ = sess.send(ctx, Envelope{Event: EventConsoleTruncated, Data: consoleTruncatedData{Dropped: dropped}})
			}
			_ = sess.send(ctx, Envelope{
				Event: EventConsoleOutput, Seq: line.Seq,
				Data: consoleOutputData{Line: line.Data, Stream: line.Stream},
				TS:   time.Now().UnixMilli(),
			})

		case <-statsTicker.C:
			if frame, ok := sess.server.LatestStats(); ok {
				_ = sess.send(ctx, Envelope{Event: EventStats, Data: frame, TS: time.Now().UnixMilli()})
			}

		case <-expiryTimer.C:
			remaining := int64(time.Until(claims.ExpiresAt.Time).Seconds())
			_ = sess.send(ctx, Envelope{Event: EventTokenExpiring, Data: tokenExpiringData{SecondsRemaining: remaining}})

		case <-hardExpiry.C:
			_ = sess.send(ctx, Envelope{Event: EventTokenExpired})
			sess.conn.Close(StatusTokenExpired, "token expired")
			return
		}
	}
}

// authenticate reads exactly one frame and requires it to be a valid
// {"event":"auth"} frame within authTimeout — no other traffic is
// processed until authentication succeeds.
func (sess *wsSession) authenticate(ctx context.Context) (*auth.Claims, error) {
	ctx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()

	var env Envelope
	if err := readJSON(ctx, sess.conn, &env); err != nil {
		return nil, err
	}
	if env.Event != EventAuth {
		return nil, errNotAuthFrame
	}
	var data authData
	if err := remarshal(env.Data, &data); err != nil {
		return nil, err
	}

	claims, err := sess.verifier.Verify(data.Token, sess.server.UUID, auth.CapConsole)
	if err != nil {
		return nil, err
	}
	if !claims.HasPermission("websocket.connect") {
		return nil, errMissingBaselinePermission
	}
	return claims, nil
}

func (sess *wsSession) sendAuthOK(ctx context.Context) error {
	return sess.send(ctx, Envelope{
		Event: EventAuthOK,
		Data:  authOKData{Permissions: sess.claims.Permissions, ExpiresAt: sess.claims.ExpiresAt.Unix()},
	})
}

// replayScrollback sends everything currently in the ring buffer so a
// freshly connected client isn't staring at a blank terminal.
func (sess *wsSession) replayScrollback(ctx context.Context) {
	lines, _ := sess.server.Hub.RingSince(0)
	for _, l := range lines {
		_ = sess.send(ctx, Envelope{
			Event: EventConsoleOutput, Seq: l.Seq,
			Data: consoleOutputData{Line: l.Data, Stream: l.Stream},
		})
	}
}

func (sess *wsSession) readLoop(ctx context.Context, out chan<- Envelope, errCh chan<- error) {
	for {
		var env Envelope
		if err := readJSON(ctx, sess.conn, &env); err != nil {
			errCh <- err
			return
		}
		select {
		case out <- env:
		case <-ctx.Done():
			return
		}
	}
}

// handleInbound processes one client frame. Returns false if the
// connection should be closed.
func (sess *wsSession) handleInbound(ctx context.Context, env Envelope) bool {
	switch env.Event {
	case EventAuth:
		// Re-auth on the SAME socket, per architecture doc 3.4: this is
		// how a subuser's access can be narrowed or revoked mid-session
		// without dropping the connection — the client re-fetches a token
		// and the agent re-verifies without ever reconnecting.
		var data authData
		if err := remarshal(env.Data, &data); err != nil {
			sess.sendError(ctx, "BAD_REQUEST", err.Error(), false)
			return true
		}
		claims, err := sess.verifier.Verify(data.Token, sess.server.UUID, auth.CapConsole)
		if err != nil {
			sess.sendError(ctx, "REAUTH_FAILED", err.Error(), true)
			sess.conn.Close(StatusAuthFailed, "re-authentication failed")
			return false
		}
		sess.claims = claims
		_ = sess.sendAuthOK(ctx)
		return true

	case EventConsoleSend:
		return sess.handleConsoleSend(ctx, env)

	case EventPowerSet:
		return sess.handlePowerSet(ctx, env)

	case EventPing:
		_ = sess.send(ctx, Envelope{Event: EventPong})
		return true

	case EventLogsRequest, EventStatsRequest:
		// Accepted no-ops in M2: the ring replay and the 2s stats ticker
		// already cover these; explicit on-demand refresh can be added
		// once a client actually needs it.
		return true

	default:
		sess.sendError(ctx, "UNKNOWN_EVENT", "unrecognized event: "+env.Event, false)
		return true
	}
}

// handleConsoleSend validates synchronously (permission, rate limit,
// sanitization — all fast, in-memory checks) but performs the actual
// stdin write in its OWN goroutine. This matters: writing to a container's
// stdin is a blocking I/O call against the Docker daemon, and the session
// run() loop is single-threaded — if this write happened inline, a slow
// or momentarily-stuck write would also stall stats delivery and console
// output for the same connection (they are all serviced by the same
// select loop). websocket.Conn's Write/Writer are documented safe for
// concurrent use, so sending the result from a background goroutine is
// safe without any extra locking.
func (sess *wsSession) handleConsoleSend(ctx context.Context, env Envelope) bool {
	if !sess.claims.HasPermission("control.console") {
		sess.sendError(ctx, "E_PERMISSION_DENIED", "missing control.console", false)
		return true
	}
	if !sess.limiter.Allow() {
		sess.sendError(ctx, "RATE_LIMITED", "console input rate limit exceeded", false)
		return true
	}
	var data consoleSendData
	if err := remarshal(env.Data, &data); err != nil {
		sess.sendError(ctx, "BAD_REQUEST", err.Error(), false)
		return true
	}
	line, err := console.SanitizeInputLine(data.Command)
	if err != nil {
		sess.sendError(ctx, "BAD_REQUEST", err.Error(), false)
		return true
	}
	go func() {
		if err := sess.server.WriteConsole(line); err != nil {
			sess.sendError(ctx, "SERVER_OFFLINE", err.Error(), false)
		}
	}()
	return true
}

func (sess *wsSession) handlePowerSet(ctx context.Context, env Envelope) bool {
	var data powerSetData
	if err := remarshal(env.Data, &data); err != nil {
		sess.sendError(ctx, "BAD_REQUEST", err.Error(), false)
		return true
	}

	requiredPerm := map[string]string{
		"start": "control.start", "stop": "control.stop",
		"restart": "control.restart", "kill": "control.kill",
	}[data.Action]
	if requiredPerm == "" {
		sess.sendError(ctx, "BAD_REQUEST", "unknown power action: "+data.Action, false)
		return true
	}
	if !sess.claims.HasPermission(requiredPerm) {
		sess.sendError(ctx, "E_PERMISSION_DENIED", "missing "+requiredPerm, false)
		return true
	}

	// Same reasoning as handleConsoleSend: a power action can legitimately
	// take up to the configured stop timeout (30s) to complete, and must
	// never block this connection's stats/console delivery — or, worse,
	// every OTHER connection's, since Server.mu is held for the duration
	// of the underlying Docker call.
	go func() {
		prev := string(sess.server.State)
		if err := performPower(ctx, sess.dc, sess.server, data.Action); err != nil {
			sess.sendError(ctx, "POWER_ACTION_FAILED", err.Error(), false)
			return
		}
		_ = sess.send(ctx, Envelope{Event: EventStatus, Data: statusData{State: string(sess.server.State), Previous: prev}})
		sess.reportActivity("server.power."+data.Action, map[string]interface{}{"previous": prev, "state": string(sess.server.State)})
	}()
	return true
}

// reportActivity best-effort attributes a WS-driven mutation to the panel's
// activity feed (see panel.Client.ReportActivity's doc comment). Uses
// sess.bgCtx, not the frame-handling ctx above — this call happens AFTER
// the WS frame that triggered it has already been fully handled, and must
// survive the browser closing the connection a moment later.
func (sess *wsSession) reportActivity(event string, properties map[string]interface{}) {
	if sess.panelClient == nil {
		return // standalone mode — nothing to report to
	}
	reqCtx, cancel := context.WithTimeout(sess.bgCtx, 10*time.Second)
	defer cancel()
	if err := sess.panelClient.ReportActivity(reqCtx, sess.tokenStore.Get(), sess.server.UUID, panel.ActivityRequest{
		UserID:     sess.claims.UID,
		Event:      event,
		Properties: properties,
	}); err != nil {
		sess.log.Warn("report activity failed", "event", event, "err", err)
	}
}

func (sess *wsSession) send(ctx context.Context, env Envelope) error {
	if env.TS == 0 {
		env.TS = time.Now().UnixMilli()
	}
	return writeJSON(ctx, sess.conn, env)
}

func (sess *wsSession) sendError(ctx context.Context, code, message string, fatal bool) {
	_ = sess.send(ctx, Envelope{Event: EventError, Data: errorData{Code: code, Message: message, Fatal: fatal}})
}

// readJSON/writeJSON delegate to the library's own wsjson helpers rather
// than hand-rolling json.NewDecoder/Encoder over c.Reader()/c.Writer().
// That hand-rolled version was tried first and is a real trap: coder/
// websocket requires each message's Reader to be drained to EOF before the
// next Reader() call, but json.Decoder.Decode stops as soon as it has
// parsed one complete value — for a short, single-object message it
// typically does NOT perform the extra read that would observe EOF, so
// the connection's next Reader() call fails with "previous message not
// read to completion" even though decoding the current message "worked".
// This exact failure was caught live while smoke-testing this milestone:
// auth succeeded, but every message after it silently vanished. wsjson.
// Read/Write read/write the whole message correctly and are what the
// library's own docs point to for this reason.
func readJSON(ctx context.Context, c *websocket.Conn, v any) error {
	return wsjson.Read(ctx, c, v)
}

func writeJSON(ctx context.Context, c *websocket.Conn, v any) error {
	return wsjson.Write(ctx, c, v)
}

func remarshal(from any, to any) error {
	b, err := json.Marshal(from)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, to)
}
