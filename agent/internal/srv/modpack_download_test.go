package srv

import (
	"context"
	"crypto/sha512"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownloadVerifiedAcceptsStaleSizeWhenChecksumMatches(t *testing.T) {
	body := []byte("valid artifact with two extra bytes")
	hash := sha512.Sum512(body)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "artifact.jar")
	if err := downloadVerified(context.Background(), server.URL, dest, int64(len(body)-2), "", hex.EncodeToString(hash[:])); err != nil {
		t.Fatalf("expected checksum-authoritative download to succeed: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(body) {
		t.Fatalf("downloaded body changed: %q", got)
	}
}

func TestDownloadVerifiedStillRejectsWrongChecksum(t *testing.T) {
	body := []byte("tampered artifact")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	defer server.Close()

	err := downloadVerified(context.Background(), server.URL, filepath.Join(t.TempDir(), "artifact.jar"), int64(len(body)-2), "", strings.Repeat("0", 128))
	if err == nil || !strings.Contains(err.Error(), "checksum verification failed") {
		t.Fatalf("expected checksum failure, got %v", err)
	}
}

func TestDownloadVerifiedRejectsLargeSizeOverrunBeforeReading(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "2097152")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	err := downloadVerified(context.Background(), server.URL, filepath.Join(t.TempDir(), "artifact.jar"), 10, "", strings.Repeat("0", 128))
	if err == nil || !strings.Contains(err.Error(), "content-length exceeds safety limit") {
		t.Fatalf("expected safety-limit failure, got %v", err)
	}
}
