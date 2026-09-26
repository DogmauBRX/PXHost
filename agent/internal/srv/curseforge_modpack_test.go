package srv

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestAllowedCurseForgeURL(t *testing.T) {
	for _, raw := range []string{
		"http://edge.forgecdn.net/files/1/2/a.jar",
		"https://edge.forgecdn.net.evil.test/a.jar",
		"https://user@edge.forgecdn.net/a.jar",
		"https://cdn.modrinth.com/a.jar",
		"https://forgecdn.net/a.jar",
	} {
		if err := allowedCurseForgeURL(raw); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
	for _, raw := range []string{
		"https://edge.forgecdn.net/files/4567/123/pack.zip",
		"https://mediafilez.forgecdn.net/files/4567/123/pack.zip",
	} {
		if err := allowedCurseForgeURL(raw); err != nil {
			t.Fatalf("expected %q to be accepted: %v", raw, err)
		}
	}
}

func zipFiles(t *testing.T, entries map[string]string) []*zip.File {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	return zr.File
}

func TestReadCurseForgeManifest(t *testing.T) {
	files := zipFiles(t, map[string]string{
		"manifest.json":           `{"overrides":"overrides","files":[{"projectID":10,"fileID":20,"required":true},{"projectID":11,"fileID":21,"required":false}]}`,
		"overrides/config/a.toml": "a=1",
	})
	manifest, err := readCurseForgeManifest(files)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Overrides != "overrides" || len(manifest.Files) != 2 || manifest.Files[0].FileID != 20 || !manifest.Files[0].Required {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
}

func TestReadCurseForgeManifestRejectsUnsafeOrMissing(t *testing.T) {
	if _, err := readCurseForgeManifest(zipFiles(t, map[string]string{"modrinth.index.json": "{}"})); err == nil || !strings.Contains(err.Error(), "manifest.json is missing") {
		t.Fatalf("expected missing-manifest error, got %v", err)
	}
	for _, overrides := range []string{"", "../escape", "/abs", `back\slash`} {
		files := zipFiles(t, map[string]string{"manifest.json": `{"overrides":"` + strings.ReplaceAll(overrides, `\`, `\\`) + `","files":[]}`})
		if _, err := readCurseForgeManifest(files); err == nil {
			t.Fatalf("expected overrides %q to be rejected", overrides)
		}
	}
}

func TestHasArchivePrefixDoesNotMatchSiblingDirectory(t *testing.T) {
	if !hasArchivePrefix("overrides/config/a.toml", "overrides") {
		t.Fatal("expected entry inside overrides to match")
	}
	if hasArchivePrefix("overrides-extra/a.toml", "overrides") {
		t.Fatal("sibling directory must not match the overrides prefix")
	}
}

func TestExtractCurseForgeOverridesOnlyWritesInsidePrefix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("extraction chowns files, which Windows does not support")
	}
	root := t.TempDir()
	files := zipFiles(t, map[string]string{
		"manifest.json":           "{}",
		"overrides/config/a.toml": "a=1",
		"other/ignored.txt":       "no",
	})
	if err := extractCurseForgeOverrides(files, "overrides", root, os.Getuid()); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(root, "config", "a.toml")); err != nil || string(data) != "a=1" {
		t.Fatalf("override not extracted: %q %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(root, "ignored.txt")); !os.IsNotExist(err) {
		t.Fatal("entry outside overrides must not be extracted")
	}
}

func TestDownloadVerifiedWithPolicyBlocksRedirectToUnapprovedHost(t *testing.T) {
	payload := []byte("mod bytes")
	sum := sha1.Sum(payload)
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer evil.Close()
	trusted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, evil.URL+"/file", http.StatusFound)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer trusted.Close()
	trustedHost := mustHost(t, trusted.URL)
	policy := func(raw string) error {
		if mustHost(t, raw) != trustedHost {
			return os.ErrPermission
		}
		return nil
	}
	dest := filepath.Join(t.TempDir(), "file.jar")
	if err := downloadVerifiedWithPolicy(context.Background(), trusted.URL+"/file", dest, int64(len(payload)), hex.EncodeToString(sum[:]), "", policy); err != nil {
		t.Fatalf("direct download should succeed: %v", err)
	}
	if err := downloadVerifiedWithPolicy(context.Background(), trusted.URL+"/redirect", dest+"2", int64(len(payload)), hex.EncodeToString(sum[:]), "", policy); err == nil {
		t.Fatal("redirect to an unapproved host must be rejected")
	}
}

func mustHost(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Host
}
