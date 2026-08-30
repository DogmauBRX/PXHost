// Package api is the agent's HTTP + WebSocket control surface: the REST
// endpoints the panel calls (power actions, status) and the WebSocket the
// browser connects to DIRECTLY for console and stats (architecture doc
// 3.4 / 4.5 / 7).
package api

import "github.com/coder/websocket"

// Envelope is the wire format for every WebSocket message in both
// directions: {"event": "...", "data": {...}}. This mirrors the protocol
// documented in architecture doc 4.5/4.3 exactly, so a browser client and
// this agent implementation share one message shape.
type Envelope struct {
	Event string `json:"event"`
	Seq   uint64 `json:"seq,omitempty"`
	Data  any    `json:"data,omitempty"`
	TS    int64  `json:"ts,omitempty"`
}

// Inbound event names (client -> agent).
const (
	EventAuth         = "auth"
	EventConsoleSend  = "console:send"
	EventPowerSet     = "power:set"
	EventLogsRequest  = "logs:request"
	EventStatsRequest = "stats:request"
	EventPing         = "ping"
)

// Outbound event names (agent -> client).
const (
	EventAuthOK           = "auth:ok"
	EventConsoleOutput    = "console:output"
	EventConsoleTruncated = "console:truncated"
	EventStatus           = "status"
	EventStats            = "stats"
	EventTokenExpiring    = "token:expiring"
	EventTokenExpired     = "token:expired"
	EventError            = "error"
	EventPong             = "pong"
)

// WS close codes, matching architecture doc 4.3 exactly so a client can
// branch on them without parsing the reason string.
const (
	StatusAuthFailed       websocket.StatusCode = 4000
	StatusTokenExpired     websocket.StatusCode = 4001
	StatusPermissionDenied websocket.StatusCode = 4003
	StatusServerNotFound   websocket.StatusCode = 4004
	StatusServerSuspended  websocket.StatusCode = 4009
)

type authData struct {
	Token string `json:"token"`
}

type consoleSendData struct {
	Command string `json:"command"`
}

type powerSetData struct {
	Action string `json:"action"`
}

type authOKData struct {
	Permissions []string `json:"permissions"`
	ExpiresAt   int64    `json:"expiresAt"`
}

type consoleOutputData struct {
	Line   string `json:"line"`
	Stream string `json:"stream"`
}

type consoleTruncatedData struct {
	Dropped uint64 `json:"dropped"`
}

type statusData struct {
	State    string `json:"state"`
	Previous string `json:"previous,omitempty"`
}

type tokenExpiringData struct {
	SecondsRemaining int64 `json:"secondsRemaining"`
}

type errorData struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Fatal   bool   `json:"fatal"`
}
