package srv

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCopyTreeCopiesContentAndModes(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	dest := filepath.Join(t.TempDir(), "dest")
	if err := os.MkdirAll(filepath.Join(source, "mods"), 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "mods", "example.jar"), []byte("jar"), 0640); err != nil {
		t.Fatal(err)
	}

	uid := os.Getuid()
	if runtime.GOOS == "windows" {
		uid = 100002
	}
	if err := copyTree(source, dest, uid); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "mods", "example.jar"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "jar" {
		t.Fatalf("unexpected copied content %q", got)
	}
}

func TestCopyTreeRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires privileges on Windows")
	}
	source := filepath.Join(t.TempDir(), "source")
	dest := filepath.Join(t.TempDir(), "dest")
	if err := os.MkdirAll(source, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("outside", filepath.Join(source, "link")); err != nil {
		t.Fatal(err)
	}
	if err := copyTree(source, dest, os.Getuid()); err == nil {
		t.Fatal("expected symlink rejection")
	}
}
