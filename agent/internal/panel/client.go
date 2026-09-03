// Package panel is the agent's outbound client to the Panel API's
// /api/remote/* surface (architecture doc 4.2/7): the bootstrap handshake
// that trades a single-use, admin-issued token for a long-lived node
// token, and the periodic heartbeat that keeps a node's health status
// live in the panel's UI.
package panel

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	baseURL string
	http    *http.Client
}

func New(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

type BootstrapRequest struct {
	Token         string `json:"token"`
	Hostname      string `json:"hostname"`
	OS            string `json:"os,omitempty"`
	Kernel        string `json:"kernel,omitempty"`
	DockerVersion string `json:"dockerVersion,omitempty"`
	Arch          string `json:"arch,omitempty"`
}

type BootstrapResponse struct {
	NodeUUID                 string `json:"nodeUuid"`
	NodeToken                string `json:"nodeToken"`
	HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
}

// Bootstrap redeems a single-use bootstrap token for a node token. Called
// exactly once, by `pxagent bootstrap` — never by `serve`, which expects
// the node token to already be present in node.json.
func (c *Client) Bootstrap(ctx context.Context, req BootstrapRequest) (*BootstrapResponse, error) {
	var resp BootstrapResponse
	if err := c.post(ctx, "/api/remote/nodes/bootstrap", "", req, &resp); err != nil {
		return nil, fmt.Errorf("panel: bootstrap: %w", err)
	}
	return &resp, nil
}

type HeartbeatRequest struct {
	AgentVersion  string `json:"agentVersion,omitempty"`
	DockerVersion string `json:"dockerVersion,omitempty"`
	UptimeSeconds int64  `json:"uptimeSeconds,omitempty"`

	// Capacity plan Fase 7 — what the agent ACTUALLY reports about its
	// host, distinct from and never influencing the admin's DECLARED
	// commercial capacity. All omitempty: an old agent binary (or one
	// mid-tick where a source failed — see serve.go's `send()`, every
	// source here is independently best-effort) simply omits whatever it
	// doesn't have, and the panel leaves those columns untouched rather
	// than zeroing them.
	ReportedMemoryTotalMb     int64  `json:"reportedMemoryTotalMb,omitempty"`
	ReportedCPUCount          int    `json:"reportedCpuCount,omitempty"`
	ReportedDiskTotalMb       int64  `json:"reportedDiskTotalMb,omitempty"`
	ReportedDiskFreeMb        int64  `json:"reportedDiskFreeMb,omitempty"`
	ReportedOS                string `json:"reportedOs,omitempty"`
	ReportedKernel            string `json:"reportedKernel,omitempty"`
	ReportedContainersRunning int    `json:"reportedContainersRunning,omitempty"`

	// Automatic hardware-capacity detection — deeper host telemetry than
	// dockerx.Info() ever collected (CPU model/topology, current
	// load/usage, memory used/available, virtualization). Same
	// omitempty/best-effort contract as the fields above; see
	// hostinfo.CollectStatic's doc comment for why
	// ReportedCPUPhysicalCores/ReportedCPUSockets are deliberately absent
	// when the agent detects it's running inside an LXC container.
	ReportedCPUModel             string  `json:"reportedCpuModel,omitempty"`
	ReportedCPUSockets           int     `json:"reportedCpuSockets,omitempty"`
	ReportedCPUPhysicalCores     int     `json:"reportedCpuPhysicalCores,omitempty"`
	ReportedCPUUsagePercent      int     `json:"reportedCpuUsagePercent,omitempty"`
	ReportedLoadAvg1             float64 `json:"reportedLoadAvg1,omitempty"`
	ReportedMemoryUsedMb         int64   `json:"reportedMemoryUsedMb,omitempty"`
	ReportedMemoryAvailableMb    int64   `json:"reportedMemoryAvailableMb,omitempty"`
	ReportedVirtualizationSystem string  `json:"reportedVirtualizationSystem,omitempty"`
	ReportedVirtualizationRole   string  `json:"reportedVirtualizationRole,omitempty"`
}

type HeartbeatResponse struct {
	Status string `json:"status"`
}

type InstallCompletedRequest struct {
	Successful   bool   `json:"successful"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

// InstallCompleted reports an install run's outcome (architecture doc
// 4.2/7). The HTTP call that originally requested the install has long
// since returned 202 — this is the async follow-up that actually moves
// the server from "installing" to "ready" or "install_failed" on the
// panel side.
func (c *Client) InstallCompleted(ctx context.Context, nodeToken, serverUUID string, req InstallCompletedRequest) error {
	path := fmt.Sprintf("/api/remote/servers/%s/install-completed", serverUUID)
	if err := c.post(ctx, path, nodeToken, req, nil); err != nil {
		return fmt.Errorf("panel: install-completed: %w", err)
	}
	return nil
}

// Heartbeat reports liveness using the long-lived node token obtained
// from Bootstrap. Called on a fixed interval by `serve` for as long as
// the agent process runs.
func (c *Client) Heartbeat(ctx context.Context, nodeToken string, req HeartbeatRequest) (*HeartbeatResponse, error) {
	var resp HeartbeatResponse
	if err := c.post(ctx, "/api/remote/nodes/heartbeat", nodeToken, req, &resp); err != nil {
		return nil, fmt.Errorf("panel: heartbeat: %w", err)
	}
	return &resp, nil
}

type ActivityRequest struct {
	UserID     string                 `json:"userId"`
	Event      string                 `json:"event"`
	Properties map[string]interface{} `json:"properties,omitempty"`
}

// ReportActivity attributes a WS-driven mutation (currently: power
// actions) to the user whose capability token authorized it, for the
// panel's customer-facing activity feed (architecture doc roadmap M11:
// "every mutation attributed in the feed"). Found live: everything
// REST-driven (files, backups, databases, schedules) is already
// attributed by the panel API itself, since it's the one deciding
// whether the action happens at all — but a power action the browser
// sends over the console WebSocket never touches the panel API, only
// this agent, which is the ONLY place that ever learns both "it
// happened" and "who authorized it" (the capability token's `uid`).
// Best-effort: a panel outage must never block a power action that
// already succeeded against the real container.
func (c *Client) ReportActivity(ctx context.Context, nodeToken, serverUUID string, req ActivityRequest) error {
	path := fmt.Sprintf("/api/remote/servers/%s/activity", serverUUID)
	if err := c.post(ctx, path, nodeToken, req, nil); err != nil {
		return fmt.Errorf("panel: report-activity: %w", err)
	}
	return nil
}

type RotateTokenResponse struct {
	NodeToken string `json:"nodeToken"`
}

// RotateToken trades the node's current token for a fresh one in one
// round trip (architecture doc roadmap M13: "token rotation"). Called
// periodically by `serve` on its own schedule, authenticated with the
// token still valid at call time — the caller must apply the returned
// token (in-memory AND node.json) before this credential's next use, but
// there is no gap where NEITHER token works: the old one stays valid
// until the panel's transaction here commits, which has already
// happened by the time this function returns.
func (c *Client) RotateToken(ctx context.Context, nodeToken string) (*RotateTokenResponse, error) {
	var resp RotateTokenResponse
	if err := c.post(ctx, "/api/remote/nodes/rotate-token", nodeToken, struct{}{}, &resp); err != nil {
		return nil, fmt.Errorf("panel: rotate-token: %w", err)
	}
	return &resp, nil
}

type TransferResultRequest struct {
	TransferID   string `json:"transferId"`
	Successful   bool   `json:"successful"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

// TransferResult reports a node-to-node transfer's outcome, called by
// the TARGET node once its async import (archive fetch + extract +
// container create) finishes — same "202 now, real answer later" shape
// as InstallCompleted, for the same reason: a multi-gigabyte archive can
// take far longer than any HTTP client's timeout should be set to.
func (c *Client) TransferResult(ctx context.Context, nodeToken string, req TransferResultRequest) error {
	if err := c.post(ctx, "/api/remote/transfers/result", nodeToken, req, nil); err != nil {
		return fmt.Errorf("panel: transfer-result: %w", err)
	}
	return nil
}

type jwksResponse struct {
	Keys []struct {
		Kid       string `json:"kid"`
		PublicKey string `json:"publicKey"`
	} `json:"keys"`
}

// FetchJWKS retrieves every currently-trusted capability-token signing
// key (architecture doc 3.4/roadmap M13). Public endpoint — no bearer
// token, same reasoning as JwksController's doc comment on the panel
// side. Called on a fixed interval by cmd/pxagent's runJWKSRefreshLoop;
// a fetch failure there just means the CURRENT key set keeps being
// trusted until the next successful refresh, never a hard failure.
func (c *Client) FetchJWKS(ctx context.Context) (map[string]ed25519.PublicKey, error) {
	var resp jwksResponse
	if err := c.get(ctx, "/api/remote/jwks", &resp); err != nil {
		return nil, fmt.Errorf("panel: fetch-jwks: %w", err)
	}
	keys := make(map[string]ed25519.PublicKey, len(resp.Keys))
	for _, k := range resp.Keys {
		raw, err := base64.StdEncoding.DecodeString(k.PublicKey)
		if err != nil {
			return nil, fmt.Errorf("panel: jwks key %q: invalid base64: %w", k.Kid, err)
		}
		if len(raw) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("panel: jwks key %q: expected %d bytes, got %d", k.Kid, ed25519.PublicKeySize, len(raw))
		}
		keys[k.Kid] = ed25519.PublicKey(raw)
	}
	return keys, nil
}

// get is post's unauthenticated, no-body sibling — used only by
// FetchJWKS today, which needs neither a bearer token nor a request body.
func (c *Client) get(ctx context.Context, path string, out interface{}) error {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("panel returned %d: %s", resp.StatusCode, truncate(respBody, 500))
	}
	return json.Unmarshal(respBody, out)
}

func (c *Client) post(ctx context.Context, path, bearerToken string, body, out interface{}) error {
	b, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("encoding request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(b))
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if bearerToken != "" {
		httpReq.Header.Set("Authorization", "Bearer "+bearerToken)
	}

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("panel returned %d: %s", resp.StatusCode, truncate(respBody, 500))
	}
	if out != nil {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("decoding response: %w", err)
		}
	}
	return nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}
