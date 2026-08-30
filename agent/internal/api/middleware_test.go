package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCorsForBrowser_AllowsConfiguredOriginOnly(t *testing.T) {
	s := New(Config{NodeUUID: "n", TokenStore: NewTokenStore("t"), WSOriginPatterns: []string{"http://localhost:5173"}})
	handler := s.corsForBrowser(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))

	allowed := httptest.NewRequest(http.MethodPost, "/x", nil)
	allowed.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, allowed)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("expected the configured origin to be echoed back, got %q", got)
	}

	denied := httptest.NewRequest(http.MethodPost, "/x", nil)
	denied.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, denied)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no CORS header for an unlisted origin, got %q", got)
	}
}

func TestCorsForBrowser_OptionsShortCircuitsWithoutCallingNext(t *testing.T) {
	s := New(Config{NodeUUID: "n", TokenStore: NewTokenStore("t"), WSOriginPatterns: []string{"http://localhost:5173"}})
	called := false
	handler := s.corsForBrowser(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))

	req := httptest.NewRequest(http.MethodOptions, "/x", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if called {
		t.Fatal("expected the preflight OPTIONS request to be handled without invoking the wrapped handler")
	}
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for a preflight, got %d", rec.Code)
	}
}
