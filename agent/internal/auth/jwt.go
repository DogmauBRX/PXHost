// Package auth implements the agent's side of the two authentication
// mechanisms described in architecture doc 3.4 / 4.5:
//
//  1. A short-lived, Ed25519-signed "capability token" the panel mints for
//     a browser client, verified entirely OFFLINE by the agent against a
//     cached public key — no network round-trip to the panel is ever
//     needed to authorize a console/stats connection, which is what keeps
//     a running server's console usable even while the panel is down.
//  2. A static per-node bearer token for machine-to-machine calls (panel
//     REST calls into the agent's control API). Full rotation/issuance is
//     a panel feature (later milestone); M2 verifies it with a constant-
//     time comparison against the node's configured secret.
package auth

import (
	"crypto/ed25519"
	"crypto/subtle"
	"fmt"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Capability identifies what a capability token authorizes.
type Capability string

const (
	CapConsole        Capability = "ws"
	CapFileDownload   Capability = "file.download"
	CapFileUpload     Capability = "file.upload"
	CapBackupDownload Capability = "backup.download"
	CapTransferDownload Capability = "transfer.download"
)

// TokenContext narrows a file.download/file.upload/backup.download/
// transfer.download token to exactly one resource — architecture doc
// 3.4's `ctx` field. For a file transfer, Path is the file's
// jail-relative path; for a backup or node-to-node-transfer download,
// Path holds the backup/archive id instead (the SAME field, since all
// three are "the one thing this token may reach," not different
// concepts per capability). MaxBytes only applies to uploads. A console
// token has no ctx (nil): it authorizes the whole console/stats stream
// for the server named in `sub`, not a single resource.
type TokenContext struct {
	Path     string `json:"path,omitempty"`
	MaxBytes int64  `json:"maxBytes,omitempty"`
}

// Claims mirrors the AgentCapabilityToken shape from architecture doc 3.4.
type Claims struct {
	jwt.RegisteredClaims
	UID         string        `json:"uid"` // acting user uuid, for the agent's activity log
	Cap         Capability    `json:"cap"`
	Permissions []string      `json:"permissions"`
	Ctx         *TokenContext `json:"ctx,omitempty"`
}

// HasPermission reports whether the token's permission set grants key.
func (c Claims) HasPermission(key string) bool {
	for _, p := range c.Permissions {
		if p == key {
			return true
		}
	}
	return false
}

// TokenVerifier verifies panel-signed capability tokens fully offline.
// Safe for concurrent use. Holds MULTIPLE keys, not one (roadmap M13:
// "signing keys carry next/current/retiring states") — a rotation stays
// zero-downtime only if a token minted seconds before rotation, under
// the OLD key, still verifies right up to its own expiry; SetKeys swaps
// the whole trusted set atomically on every JWKS refresh (see
// cmd/pxagent's runJWKSRefreshLoop), so there's no window where a
// request racing a refresh sees a half-updated key set.
type TokenVerifier struct {
	mu        sync.RWMutex
	keys      map[string]ed25519.PublicKey // by kid — populated by SetKeys from the panel's JWKS
	fallback  ed25519.PublicKey            // the static panel_public_key_path key, used only for a kid SetKeys hasn't (yet) taught this verifier about — standalone mode, or before the first successful JWKS fetch
	nodeAud   string                       // "node:<uuid>" — tokens minted for another node are rejected
	clockSkew time.Duration
}

func NewTokenVerifier(fallbackPublicKey ed25519.PublicKey, nodeUUID string, clockSkew time.Duration) *TokenVerifier {
	return &TokenVerifier{
		keys:      make(map[string]ed25519.PublicKey),
		fallback:  fallbackPublicKey,
		nodeAud:   "node:" + nodeUUID,
		clockSkew: clockSkew,
	}
}

// SetKeys replaces the full trusted key set — called after every
// successful JWKS fetch, never merged incrementally: a key the JWKS no
// longer lists (retired) must stop verifying on the VERY NEXT refresh,
// not linger because some earlier fetch once saw it.
func (v *TokenVerifier) SetKeys(keys map[string]ed25519.PublicKey) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.keys = keys
}

// Verify parses and validates a capability token for a specific server.
// It is intentionally strict and fails closed on every axis:
//   - algorithm MUST be exactly EdDSA (rejects "none" and any HMAC/RSA
//     confusion attempt outright, regardless of what the token header claims)
//   - audience MUST be this node
//   - subject MUST be the server the caller is trying to reach
//   - exp/nbf MUST be valid within the configured clock skew
//   - the token's `kid` MUST match a key this verifier currently trusts
func (v *TokenVerifier) Verify(tokenString, wantServerUUID string, wantCap Capability) (*Claims, error) {
	claims := &Claims{}
	parsed, err := jwt.ParseWithClaims(tokenString, claims, func(t *jwt.Token) (interface{}, error) {
		v.mu.RLock()
		defer v.mu.RUnlock()
		kid, _ := t.Header["kid"].(string)
		if pk, ok := v.keys[kid]; ok {
			return pk, nil
		}
		if v.fallback != nil {
			return v.fallback, nil
		}
		return nil, fmt.Errorf("auth: no trusted key for kid %q", kid)
	},
		jwt.WithValidMethods([]string{"EdDSA"}),
		jwt.WithAudience(v.nodeAud),
		jwt.WithLeeway(v.clockSkew),
	)
	if err != nil {
		return nil, fmt.Errorf("auth: token rejected: %w", err)
	}
	if !parsed.Valid {
		return nil, fmt.Errorf("auth: token invalid")
	}
	if claims.Subject != wantServerUUID {
		return nil, fmt.Errorf("auth: token subject %q does not match requested server %q", claims.Subject, wantServerUUID)
	}
	if claims.Cap != wantCap {
		return nil, fmt.Errorf("auth: token capability %q does not match required %q", claims.Cap, wantCap)
	}
	if claims.ID == "" {
		return nil, fmt.Errorf("auth: token missing jti")
	}
	return claims, nil
}

// VerifyFileToken is Verify plus the two guarantees a file.download/
// file.upload token additionally needs (architecture doc 3.4): the
// token's `ctx.path` must match the path actually being requested — a
// token minted for server.properties must not also open backup.tar.gz —
// and the token is single-use, burned via replay against its jti. A
// second presentation of the same token, even for the same path, fails
// closed.
func (v *TokenVerifier) VerifyFileToken(tokenString, wantServerUUID string, wantCap Capability, wantPath string, replay *ReplayCache) (*Claims, error) {
	claims, err := v.Verify(tokenString, wantServerUUID, wantCap)
	if err != nil {
		return nil, err
	}
	if claims.Ctx == nil || claims.Ctx.Path != wantPath {
		return nil, fmt.Errorf("auth: token is not authorized for path %q", wantPath)
	}
	if !replay.Burn(claims.ID, claims.ExpiresAt.Time) {
		return nil, fmt.Errorf("auth: token %q already used (single-use)", claims.ID)
	}
	return claims, nil
}

// VerifyNodeToken performs a constant-time comparison of a bearer secret
// against the node's configured value. Constant-time comparison matters
// here: a naive == would let a timing attack narrow down the secret
// byte-by-byte over enough requests.
func VerifyNodeToken(presented, want string) bool {
	if len(presented) == 0 || len(want) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(want)) == 1
}
