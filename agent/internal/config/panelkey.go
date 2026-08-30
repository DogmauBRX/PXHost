package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
)

// LoadPanelPublicKey reads a base64-encoded raw Ed25519 public key (the
// format hack/devtoken writes) from disk. The real agent will fetch this
// from the panel's JWKS endpoint and cache/refresh it (architecture doc
// 3.4); this file-based loader is the local-dev equivalent.
func LoadPanelPublicKey(path string) (ed25519.PublicKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config: read panel public key %q: %w", path, err)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
	if err != nil {
		return nil, fmt.Errorf("config: decode panel public key %q: %w", path, err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("config: panel public key %q has %d bytes, want %d", path, len(raw), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}
