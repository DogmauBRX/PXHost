package fsx

import (
	"archive/zip"
	"bytes"
	"os"
	"strconv"
	"testing"
)

func buildZip(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %q: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %q: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func TestDecompress_ZipSlipEntryNameStaysInsideJail(t *testing.T) {
	j := newTestJail(t)
	zipBytes := buildZip(t, map[string]string{"../../../../etc/pwned": "attacker content"})
	if _, err := j.WriteFile("evil.zip", bytes.NewReader(zipBytes), testUID, int64(len(zipBytes))); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	extracted, skipped, err := j.Decompress("evil.zip", ".", testUID)
	// Whatever happens (reject outright, or land the entry harmlessly
	// inside the jail under a sanitized name), the ONE thing that must
	// never be true is a file appearing outside the jail root.
	_ = extracted
	_ = skipped
	_ = err

	if _, statErr := os.Stat("/etc/pwned"); statErr == nil {
		t.Fatal("zip-slip entry escaped the jail root — /etc/pwned exists")
	}
}

func TestDecompress_RegularEntriesExtractCorrectly(t *testing.T) {
	j := newTestJail(t)
	zipBytes := buildZip(t, map[string]string{
		"server.properties": "motd=hi",
		"plugins/a.txt":     "plugin data",
	})
	if _, err := j.WriteFile("pack.zip", bytes.NewReader(zipBytes), testUID, int64(len(zipBytes))); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	extracted, skipped, err := j.Decompress("pack.zip", ".", testUID)
	if err != nil {
		t.Fatalf("Decompress: %v", err)
	}
	if extracted != 2 {
		t.Fatalf("extracted = %d, want 2 (skipped=%v)", extracted, skipped)
	}

	got, err := j.ReadFile("server.properties")
	if err != nil || string(got) != "motd=hi" {
		t.Fatalf("server.properties = %q, %v", got, err)
	}
	got, err = j.ReadFile("plugins/a.txt")
	if err != nil || string(got) != "plugin data" {
		t.Fatalf("plugins/a.txt = %q, %v", got, err)
	}
}

func TestDecompress_RejectsEntryCountBomb(t *testing.T) {
	j := newTestJail(t)
	entries := make(map[string]string, maxArchiveEntries+1)
	for i := 0; i < maxArchiveEntries+1; i++ {
		entries[padName(i)] = "x"
	}
	zipBytes := buildZip(t, entries)
	if _, err := j.WriteFile("many.zip", bytes.NewReader(zipBytes), testUID, int64(len(zipBytes))); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, _, err := j.Decompress("many.zip", ".", testUID); err == nil {
		t.Fatal("expected Decompress to reject an archive over the entry-count limit")
	}
}

func padName(i int) string {
	return "f" + strconv.Itoa(i)
}

func TestCompress_ThenDecompressRoundTrips(t *testing.T) {
	src := newTestJail(t)
	if _, err := src.WriteFile("a.txt", bytes.NewReader([]byte("hello")), testUID, 100); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := src.Mkdir("sub", testUID); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if _, err := src.WriteFile("sub/b.txt", bytes.NewReader([]byte("world")), testUID, 100); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if err := src.Compress([]string{"a.txt", "sub"}, "bundle.zip", testUID); err != nil {
		t.Fatalf("Compress: %v", err)
	}

	dest := newTestJail(t)
	archiveBytes, err := src.ReadFile("bundle.zip")
	if err != nil {
		t.Fatalf("ReadFile(bundle.zip): %v", err)
	}
	if _, err := dest.WriteFile("bundle.zip", bytes.NewReader(archiveBytes), testUID, int64(len(archiveBytes))); err != nil {
		t.Fatalf("WriteFile into dest: %v", err)
	}
	extracted, _, err := dest.Decompress("bundle.zip", "out", testUID)
	if err != nil {
		t.Fatalf("Decompress: %v", err)
	}
	if extracted != 2 {
		t.Fatalf("extracted = %d, want 2", extracted)
	}
	got, err := dest.ReadFile("out/a.txt")
	if err != nil || string(got) != "hello" {
		t.Fatalf("out/a.txt = %q, %v", got, err)
	}
	got, err = dest.ReadFile("out/sub/b.txt")
	if err != nil || string(got) != "world" {
		t.Fatalf("out/sub/b.txt = %q, %v", got, err)
	}
}
