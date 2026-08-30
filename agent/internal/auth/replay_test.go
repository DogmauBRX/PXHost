package auth

import (
	"testing"
	"time"
)

func TestReplayCache_FirstBurnSucceedsSecondFails(t *testing.T) {
	c := NewReplayCache()
	exp := time.Now().Add(time.Minute)
	if !c.Burn("jti-1", exp) {
		t.Fatal("first Burn of a fresh jti should succeed")
	}
	if c.Burn("jti-1", exp) {
		t.Fatal("second Burn of the SAME jti should be rejected as a replay")
	}
}

func TestReplayCache_DistinctJtisAreIndependent(t *testing.T) {
	c := NewReplayCache()
	exp := time.Now().Add(time.Minute)
	if !c.Burn("a", exp) || !c.Burn("b", exp) {
		t.Fatal("two distinct jtis should both burn successfully")
	}
}

func TestReplayCache_PrunesExpiredEntries(t *testing.T) {
	c := NewReplayCache()
	past := time.Now().Add(-time.Minute)
	c.Burn("expired-jti", past)
	// A later Burn call triggers pruning; the expired entry should no
	// longer block a fresh presentation of the SAME jti once its own
	// token lifetime has passed — this bounds the cache's memory, it
	// does not re-authorize an old token (the JWT itself would already
	// be expired and rejected by Verify's own exp check well before
	// ReplayCache is ever consulted).
	if !c.Burn("expired-jti", time.Now().Add(time.Minute)) {
		t.Fatal("an entry past its own expiry should have been pruned, allowing reuse of the jti string")
	}
}
