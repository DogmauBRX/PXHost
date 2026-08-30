package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"os"
	"strings"
	"testing"
)

func writeRawTarGz(t *testing.T, dir, name string, entries map[string]string) string {
	t.Helper()
	path := dir + "/" + name
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %q: %v", path, err)
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for entryName, content := range entries {
		hdr := &tar.Header{Name: entryName, Size: int64(len(content)), Mode: 0o644, Typeflag: tar.TypeReg}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("WriteHeader(%q): %v", entryName, err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatalf("Write(%q): %v", entryName, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return path
}

func TestRestore_RoundTripsThroughCreateAndRestore(t *testing.T) {
	ctx := context.Background()
	src := newTestServerJail(t)
	if _, err := src.WriteFile("world.dat", strings.NewReader("original world"), os.Getuid(), 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}

	backupRoot := t.TempDir()
	p := NewLocalProvider(backupRoot)
	b, err := p.Create(ctx, "server-1", src, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	dest := newTestServerJail(t)
	if err := p.Restore(ctx, "server-1", b.ID, dest, os.Getuid()); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	got, err := dest.ReadFile("world.dat")
	if err != nil || string(got) != "original world" {
		t.Fatalf("restored world.dat = %q, %v", got, err)
	}
}

func TestRestore_RejectsBackupIdThatDoesNotExist(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	dest := newTestServerJail(t)
	err := p.Restore(context.Background(), "server-1", "20260101T000000Z-abcd", dest, os.Getuid())
	if err == nil {
		t.Fatal("expected Restore to fail for a backup id that was never created")
	}
}

func TestRestore_TarSlipEntryNeverEscapesTheStagingJail(t *testing.T) {
	backupRoot := t.TempDir()
	if err := os.MkdirAll(backupRoot+"/server-1", 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writeRawTarGz(t, backupRoot+"/server-1", "evil.tar.gz", map[string]string{
		"../../../../etc/pwned": "attacker content",
	})
	os.Rename(backupRoot+"/server-1/evil.tar.gz", backupRoot+"/server-1/20260101T000000Z-evil.tar.gz")

	p := NewLocalProvider(backupRoot)
	dest := newTestServerJail(t)
	// Whatever the outcome (error, or the entry landing harmlessly inside
	// the jail under its sanitized name), the ONE thing that must never
	// be true is a file appearing outside the jail root.
	_ = p.Restore(context.Background(), "server-1", "20260101T000000Z-evil", dest, os.Getuid())

	if _, err := os.Stat("/etc/pwned"); err == nil {
		t.Fatal("tar-slip entry escaped the staging jail — /etc/pwned exists")
	}
}

func TestRestore_ValidationRejectsEntryCountBombBeforeWritingAnything(t *testing.T) {
	backupRoot := t.TempDir()
	os.MkdirAll(backupRoot+"/server-1", 0o750)
	entries := make(map[string]string, maxRestoreEntries+1)
	for i := 0; i < maxRestoreEntries+1; i++ {
		entries[padName(i)] = "x"
	}
	writeRawTarGz(t, backupRoot+"/server-1", "20260101T000000Z-many.tar.gz", entries)

	p := NewLocalProvider(backupRoot)
	dest := newTestServerJail(t)
	err := p.Restore(context.Background(), "server-1", "20260101T000000Z-many", dest, os.Getuid())
	if err == nil {
		t.Fatal("expected Restore to reject an archive over the entry-count limit")
	}
	entriesAfter, listErr := dest.List(".")
	if listErr != nil {
		t.Fatalf("List: %v", listErr)
	}
	if len(entriesAfter) != 0 {
		t.Fatalf("dry-run validation should reject BEFORE writing anything — staging dir has %+v", entriesAfter)
	}
}

func padName(i int) string {
	return "f" + itoa(i)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}
