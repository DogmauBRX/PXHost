package srv

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAllowedModrinthURL(t *testing.T) {
	for _, raw := range []string{
		"http://cdn.modrinth.com/data/a/file.jar",
		"https://cdn.modrinth.com.evil.test/file.jar",
		"https://user@cdn.modrinth.com/file.jar",
		"https://example.com/file.jar",
	} {
		if err := allowedModrinthURL(raw); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
	if err := allowedModrinthURL("https://cdn.modrinth.com/data/a/versions/b/file.jar"); err != nil {
		t.Fatal(err)
	}
}

func TestSafeRelative(t *testing.T) {
	for _, value := range []string{"../secret", "/etc/passwd", "mods/../../secret", ""} {
		if err := safeRelative(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
	for _, value := range []string{"mods/example.jar", "config/example.toml"} {
		if err := safeRelative(value); err != nil {
			t.Fatalf("expected %q to be accepted: %v", value, err)
		}
	}
}

func TestValidateMrpackEntriesNamesCorruptedOverride(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "broken.mrpack")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(file)
	header := &zip.FileHeader{Name: "overrides/config/broken.txt", Method: zip.Store}
	entry, err := zw.CreateHeader(header)
	if err == nil {
		_, err = entry.Write(bytes.Repeat([]byte("broken override payload"), 32))
	}
	if closeErr := zw.Close(); err == nil {
		err = closeErr
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 30 || !bytes.Equal(data[:4], []byte("PK\x03\x04")) {
		t.Fatal("test ZIP has no local file header")
	}
	nameLen := int(binary.LittleEndian.Uint16(data[26:28]))
	extraLen := int(binary.LittleEndian.Uint16(data[28:30]))
	payloadStart := 30 + nameLen + extraLen
	descriptorOffset := bytes.Index(data[payloadStart:], []byte("PK\x07\x08"))
	if descriptorOffset < 2 {
		t.Fatal("test ZIP has no usable data descriptor")
	}
	data[payloadStart+descriptorOffset/2] ^= 0xff
	if err := os.WriteFile(archivePath, data, 0600); err != nil {
		t.Fatal(err)
	}

	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		t.Fatalf("central directory should remain readable: %v", err)
	}
	defer zr.Close()
	err = validateMrpackEntries(zr.File)
	if err == nil || !strings.Contains(err.Error(), "overrides/config/broken.txt") || !strings.Contains(err.Error(), "pacote corrompido") {
		t.Fatalf("expected a named corrupt-entry error, got %v", err)
	}
}
