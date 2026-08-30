package api

import "sync/atomic"

// TokenStore holds the node's current bearer token as a single
// hot-swappable value, shared by every goroutine that either checks
// incoming panel calls against it (Server's requireNodeToken middleware)
// or presents it on outgoing calls (the heartbeat and self-rotation
// loops in cmd/pxagent). Token rotation (architecture doc roadmap M13)
// updates it in exactly one place, so there is never a moment where the
// middleware and an in-flight outbound call disagree about which token
// is current.
type TokenStore struct {
	v atomic.Value
}

func NewTokenStore(initial string) *TokenStore {
	ts := &TokenStore{}
	ts.v.Store(initial)
	return ts
}

func (ts *TokenStore) Get() string {
	v, _ := ts.v.Load().(string)
	return v
}

func (ts *TokenStore) Set(token string) {
	ts.v.Store(token)
}
