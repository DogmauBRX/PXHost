package fsx

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testUID chowns to the test process's OWN uid — a non-root process can
// never chown a file to an ARBITRARY uid (that needs CAP_CHOWN, which the
// real production agent has via its systemd unit; see srv/install.go's
// chown comment for the same precedent). Using 0 here would make every
// WriteFile call fail with EPERM under an unprivileged test run.
var testUID = os.Getuid()

func newTestJail(t *testing.T) *Jail {
	t.Helper()
	dir := t.TempDir()
	j, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(%q): %v", dir, err)
	}
	t.Cleanup(func() { _ = j.Close() })
	return j
}

func TestSanitize_RejectsDotDot(t *testing.T) {
	cases := []string{"../etc/passwd", "a/../../b", "..", "a/..", "....//..../etc/passwd"}
	for _, c := range cases {
		if _, err := sanitize(c); err == nil {
			// "....//..../etc/passwd" is actually a set of valid (if
			// unusual) literal component names, not ".." traversal — only
			// assert failure for the genuinely traversal-shaped inputs.
			if c == "....//..../etc/passwd" {
				continue
			}
			t.Errorf("sanitize(%q) = nil error, want rejection", c)
		}
	}
}

func TestSanitize_AcceptsOrdinaryPaths(t *testing.T) {
	cases := map[string]string{
		"":                    ".",
		"server.properties":   "server.properties",
		"./server.properties": "server.properties",
		"a/b/c.txt":           "a/b/c.txt",
		"a//b":                "a/b",
	}
	for in, want := range cases {
		got, err := sanitize(in)
		if err != nil {
			t.Errorf("sanitize(%q) error: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSanitize_RejectsNulAndOverlong(t *testing.T) {
	if _, err := sanitize("a\x00b"); err == nil {
		t.Error("expected NUL byte to be rejected")
	}
	if _, err := sanitize(strings.Repeat("a", 300)); err == nil {
		t.Error("expected an overlong path component to be rejected")
	}
}

func TestJail_WriteThenReadRoundTrips(t *testing.T) {
	j := newTestJail(t)
	n, err := j.WriteFile("server.properties", strings.NewReader("motd=hello"), testUID, 1<<20)
	if err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if n != int64(len("motd=hello")) {
		t.Fatalf("wrote %d bytes, want %d", n, len("motd=hello"))
	}
	got, err := j.ReadFile("server.properties")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != "motd=hello" {
		t.Fatalf("ReadFile = %q, want %q", got, "motd=hello")
	}
}

func TestJail_WriteRejectsEscapingPath(t *testing.T) {
	j := newTestJail(t)
	if _, err := j.WriteFile("../escape.txt", strings.NewReader("x"), testUID, 100); err == nil {
		t.Fatal("expected WriteFile with a \"..\" path to be rejected")
	}
	// Confirm nothing was written OUTSIDE the jail root.
	if _, statErr := os.Stat(filepath.Join(j.Root(), "..", "escape.txt")); statErr == nil {
		t.Fatal("escape.txt was created outside the jail root")
	}
}

func TestJail_ReadRejectsAbsolutePathEscapeAttempt(t *testing.T) {
	j := newTestJail(t)
	// An absolute-looking path must resolve AS IF rooted at the jail, not
	// at the real filesystem root — sanitize() strips the leading "/" via
	// path.Clean("/"+x) and then TrimPrefix, so this should behave
	// identically to the relative form, never touching /etc/passwd.
	if _, err := j.ReadFile("/etc/passwd"); err == nil {
		t.Fatal("expected /etc/passwd to resolve inside the (empty) jail and fail with not-found, not succeed")
	}
}

func TestJail_ListSortsDirsFirstThenAlphabetical(t *testing.T) {
	j := newTestJail(t)
	for _, name := range []string{"zeta.txt", "alpha.txt"} {
		if _, err := j.WriteFile(name, strings.NewReader("x"), testUID, 100); err != nil {
			t.Fatalf("WriteFile(%q): %v", name, err)
		}
	}
	if err := j.Mkdir("subdir", testUID); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	entries, err := j.List(".")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("List returned %d entries, want 3", len(entries))
	}
	if !entries[0].IsDir || entries[0].Name != "subdir" {
		t.Fatalf("expected subdir first, got %+v", entries[0])
	}
	if entries[1].Name != "alpha.txt" || entries[2].Name != "zeta.txt" {
		t.Fatalf("expected alphabetical file order, got %q then %q", entries[1].Name, entries[2].Name)
	}
}

func TestJail_RenameMovesWithinJail(t *testing.T) {
	j := newTestJail(t)
	if _, err := j.WriteFile("old.txt", strings.NewReader("content"), testUID, 100); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := j.Rename("old.txt", "new.txt"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if _, err := j.ReadFile("old.txt"); err == nil {
		t.Fatal("old.txt should no longer exist after rename")
	}
	got, err := j.ReadFile("new.txt")
	if err != nil || string(got) != "content" {
		t.Fatalf("ReadFile(new.txt) = %q, %v", got, err)
	}
}

func TestJail_RemoveRecursiveDeletesTree(t *testing.T) {
	j := newTestJail(t)
	if err := j.Mkdir("world", testUID); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if _, err := j.WriteFile("world/level.dat", strings.NewReader("x"), testUID, 100); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := j.Remove("world", false); err == nil {
		t.Fatal("non-recursive Remove on a non-empty directory should fail")
	}
	if err := j.Remove("world", true); err != nil {
		t.Fatalf("recursive Remove: %v", err)
	}
	if _, err := j.List("."); err != nil {
		t.Fatalf("List after remove: %v", err)
	}
	entries, _ := j.List(".")
	if len(entries) != 0 {
		t.Fatalf("expected empty jail after recursive remove, got %+v", entries)
	}
}

func TestJail_ReadFileRejectsOversized(t *testing.T) {
	j := newTestJail(t)
	big := bytes.Repeat([]byte("a"), MaxEditableFileBytes+1)
	if _, err := j.WriteFile("big.log", bytes.NewReader(big), testUID, int64(len(big))); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, err := j.ReadFile("big.log"); err == nil {
		t.Fatal("expected ReadFile to reject a file over MaxEditableFileBytes")
	}
}

func TestJail_WriteFileRejectsOverMaxBytes(t *testing.T) {
	j := newTestJail(t)
	if _, err := j.WriteFile("f.txt", strings.NewReader("0123456789"), testUID, 5); err == nil {
		t.Fatal("expected WriteFile to reject a stream longer than maxBytes")
	}
}

func TestJail_DiskUsageAndQuota(t *testing.T) {
	j := newTestJail(t)
	if _, err := j.WriteFile("a.txt", strings.NewReader(strings.Repeat("x", 1000)), testUID, 2000); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	used, err := j.DiskUsageBytes()
	if err != nil {
		t.Fatalf("DiskUsageBytes: %v", err)
	}
	if used != 1000 {
		t.Fatalf("DiskUsageBytes = %d, want 1000", used)
	}
	if err := j.CheckQuota(500, 1); err != nil { // 1000 used + 500 new = 1500 bytes, well under 1MB
		t.Fatalf("CheckQuota should allow a write within the 1MB limit: %v", err)
	}
	if err := j.CheckQuota(10<<20, 1); err == nil {
		t.Fatal("CheckQuota should reject a write that blows well past the 1MB limit")
	}
	if err := j.CheckQuota(10<<20, 0); err != nil {
		t.Fatalf("CheckQuota with limitMb=0 (unlimited) should never reject: %v", err)
	}
}

func TestJail_ChmodMasksToRegularBits(t *testing.T) {
	j := newTestJail(t)
	if _, err := j.WriteFile("f.sh", strings.NewReader("#!/bin/sh"), testUID, 100); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	// 0o4755 has the setuid bit set — Chmod must mask it away regardless
	// of what's requested (architecture doc 4.4's "strip setuid/setgid/
	// sticky" rule isn't only an archive-extraction rule).
	if err := j.Chmod("f.sh", 0o4755); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	info, err := j.Stat("f.sh")
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Mode()&os.ModeSetuid != 0 {
		t.Fatalf("expected setuid bit to be stripped, got mode %v", info.Mode())
	}
}
