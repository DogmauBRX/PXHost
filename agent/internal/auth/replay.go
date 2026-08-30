package auth

import (
	"sync"
	"time"
)

// ReplayCache burns single-use token jti's (architecture doc 3.4:
// file.download tokens are single-use with a 60s TTL, file.upload with a
// 15min TTL — a console token is NOT single-use, since it authorizes a
// long-lived socket, so this cache is only ever consulted for file
// transfer capabilities). A jti seen once is rejected on every later
// presentation for as long as the token could still be valid, after
// which the entry is pruned so the cache never grows unbounded even
// under sustained traffic.
type ReplayCache struct {
	mu    sync.Mutex
	burnt map[string]time.Time // jti -> the token's own exp
}

func NewReplayCache() *ReplayCache {
	return &ReplayCache{burnt: make(map[string]time.Time)}
}

// Burn marks jti as used. Returns true the first time (proceed), false on
// every subsequent call for the same jti (replay — reject).
func (c *ReplayCache) Burn(jti string, expiresAt time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pruneLocked()
	if _, seen := c.burnt[jti]; seen {
		return false
	}
	c.burnt[jti] = expiresAt
	return true
}

func (c *ReplayCache) pruneLocked() {
	now := time.Now()
	for jti, exp := range c.burnt {
		if now.After(exp) {
			delete(c.burnt, jti)
		}
	}
}
