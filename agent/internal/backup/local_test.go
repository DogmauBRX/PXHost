package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pxhost/agent/internal/fsx"
)

func newTestServerJail(t *testing.T) *fsx.Jail {
	t.Helper()
	dir := t.TempDir()
	j, err := fsx.Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = j.Close() })
	return j
}

func TestLocalProvider_CreateListOpenRoundTrips(t *testing.T) {
	ctx := context.Background()
	src := newTestServerJail(t)
	if _, err := src.WriteFile("world.dat", strings.NewReader("world data"), os.Getuid(), 1000); err != nil {
		t.Fatalf("seed WriteFile: %v", err)
	}
	if err := src.Mkdir("plugins", os.Getuid()); err != nil {
		t.Fatalf("seed Mkdir: %v", err)
	}
	if _, err := src.WriteFile("plugins/a.jar", strings.NewReader("plugin bytes"), os.Getuid(), 1000); err != nil {
		t.Fatalf("seed WriteFile: %v", err)
	}

	p := NewLocalProvider(t.TempDir())
	b, err := p.Create(ctx, "server-1", src, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if b.SizeBytes == 0 || b.SHA256 == "" {
		t.Fatalf("expected non-zero size and a checksum, got %+v", b)
	}

	list, err := p.List(ctx, "server-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].ID != b.ID {
		t.Fatalf("List = %+v, want exactly [%s]", list, b.ID)
	}

	rc, size, err := p.Open(ctx, "server-1", b.ID)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer rc.Close()
	if size != b.SizeBytes {
		t.Fatalf("Open size = %d, want %d", size, b.SizeBytes)
	}

	gz, err := gzip.NewReader(rc)
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	tr := tar.NewReader(gz)
	names := map[string]bool{}
	for {
		hdr, err := tr.Next()
		if err != nil {
			break
		}
		names[hdr.Name] = true
	}
	if !names["world.dat"] || !names["plugins/a.jar"] {
		t.Fatalf("expected both files in the archive, got %v", names)
	}
}

func TestLocalProvider_IgnorePatternExcludesMatchingFiles(t *testing.T) {
	ctx := context.Background()
	src := newTestServerJail(t)
	for _, name := range []string{"keep.txt", "server.log", "world.dat"} {
		if _, err := src.WriteFile(name, strings.NewReader("x"), os.Getuid(), 100); err != nil {
			t.Fatalf("seed WriteFile(%q): %v", name, err)
		}
	}

	p := NewLocalProvider(t.TempDir())
	ignore := NewIgnoreSet("*.log")
	b, err := p.Create(ctx, "server-1", src, ignore)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	rc, _, _ := p.Open(ctx, "server-1", b.ID)
	defer rc.Close()
	gz, _ := gzip.NewReader(rc)
	tr := tar.NewReader(gz)
	var names []string
	for {
		hdr, err := tr.Next()
		if err != nil {
			break
		}
		names = append(names, hdr.Name)
	}
	for _, n := range names {
		if n == "server.log" {
			t.Fatalf("expected server.log to be excluded by the ignore pattern, archive had %v", names)
		}
	}
	if len(names) != 2 {
		t.Fatalf("expected exactly 2 entries (keep.txt, world.dat), got %v", names)
	}
}

func TestLocalProvider_DeleteRemovesArchiveAndMetadata(t *testing.T) {
	ctx := context.Background()
	src := newTestServerJail(t)
	root := t.TempDir()
	p := NewLocalProvider(root)
	b, err := p.Create(ctx, "server-1", src, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := p.Delete(ctx, "server-1", b.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "server-1", b.ID+".tar.gz")); !os.IsNotExist(err) {
		t.Fatalf("expected the archive to be gone, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "server-1", b.ID+".json")); !os.IsNotExist(err) {
		t.Fatalf("expected the metadata sidecar to be gone, stat err = %v", err)
	}

	list, _ := p.List(ctx, "server-1")
	if len(list) != 0 {
		t.Fatalf("expected an empty list after delete, got %+v", list)
	}
}

func TestLocalProvider_BackupPathRejectsUnsafeID(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	ctx := context.Background()
	if _, _, err := p.Open(ctx, "server-1", "../../etc/passwd"); err == nil {
		t.Fatal("expected a path-traversal-shaped backup id to be rejected")
	}
	if err := p.Delete(ctx, "server-1", "../escape"); err == nil {
		t.Fatal("expected Delete to reject an unsafe backup id")
	}
}

func TestLocalProvider_ListOnMissingServerReturnsEmptyNotError(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	list, err := p.List(context.Background(), "never-backed-up")
	if err != nil {
		t.Fatalf("List on a server with no backups yet should not error: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected an empty list, got %+v", list)
	}
}

func TestIgnoreSet_MatchesDirectoryPrefix(t *testing.T) {
	set := NewIgnoreSet("logs/", "cache")
	cases := map[string]bool{
		"logs/latest.log": true,
		"logs":            true,
		"cache/x.tmp":     true,
		"cache":           true,
		"keep.txt":        false,
	}
	for path, want := range cases {
		if got := set.Match(path); got != want {
			t.Errorf("Match(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestIgnoreSet_NilSetMatchesNothing(t *testing.T) {
	var set *IgnoreSet
	if set.Match("anything") {
		t.Fatal("a nil IgnoreSet should never match")
	}
}
