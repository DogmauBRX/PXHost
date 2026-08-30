package api

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

// TestListenAndServe_BindsToTheRequestedAddress is a regression test for a
// real M2 bug: ListenAndServe(addr) accepted an addr parameter but never
// assigned it to the underlying http.Server's Addr field, so Go silently
// fell back to the net/http default of ":80" — which fails outright on any
// machine where something else already owns port 80, and would otherwise
// have bound the agent's control API to every interface instead of the
// one configured for it.
func TestListenAndServe_BindsToTheRequestedAddress(t *testing.T) {
	s := New(Config{NodeUUID: "test-node", TokenStore: NewTokenStore("test-token")})

	const addr = "127.0.0.1:18443" // fixed port: avoids ":0"'s Addr field never reflecting the OS-chosen port
	errCh := make(chan error, 1)
	go func() { errCh <- s.ListenAndServe(addr) }()

	deadline := time.Now().Add(2 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 50*time.Millisecond)
		if err == nil {
			conn.Close()
			goto verify
		}
		lastErr = err
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("server on %s never became reachable: %v", addr, lastErr)

verify:
	if s.httpServer.Addr != addr {
		t.Fatalf("expected httpServer.Addr=%q, got %q", addr, s.httpServer.Addr)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if err := <-errCh; err != nil && err != http.ErrServerClosed {
		t.Fatalf("ListenAndServe returned an unexpected error: %v", err)
	}
}
