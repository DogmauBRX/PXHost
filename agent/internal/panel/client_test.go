package panel

import (
	"net/http"
	"testing"
)

func TestNewEnablesHTTP2ConnectionHealthChecks(t *testing.T) {
	c := New("https://panel.example")
	transport, ok := c.http.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", c.http.Transport)
	}
	if transport.HTTP2 == nil || transport.HTTP2.SendPingTimeout <= 0 || transport.HTTP2.PingTimeout <= 0 {
		t.Fatalf("HTTP/2 ping health checks must be on, or a dead pooled connection stalls every panel call: %+v", transport.HTTP2)
	}
	if transport.Proxy == nil {
		t.Fatal("expected the default transport's settings (proxy from environment) to be kept")
	}
}
