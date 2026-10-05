package srv

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gxhost/agent/internal/spec"
)

func TestRewriteServerPort(t *testing.T) {
	cases := []struct {
		name, in, want string
		changed        bool
	}{
		{"replaces a stale port", "motd=Bigolas\nserver-port=25765\nlevel-seed=42\n", "motd=Bigolas\nserver-port=25665\nlevel-seed=42\n", true},
		{"already correct", "server-port=25665\nmotd=x\n", "server-port=25665\nmotd=x\n", false},
		{"appends when missing", "motd=x\n", "motd=x\nserver-port=25665\n", true},
		{"handles CRLF files", "motd=x\r\nserver-port=25565\r\n", "motd=x\r\nserver-port=25665\n", true},
		{"does not touch query.port", "query.port=25565\nserver-port=25665\n", "query.port=25565\nserver-port=25665\n", false},
	}
	for _, c := range cases {
		got, changed := rewriteServerPort([]byte(c.in), 25665)
		if string(got) != c.want || changed != c.changed {
			t.Errorf("%s: got %q changed=%v, want %q changed=%v", c.name, got, changed, c.want, c.changed)
		}
	}
}

func newPortTestServer(t *testing.T, port int) *Server {
	t.Helper()
	node := spec.Node{DataDir: t.TempDir(), UIDRangeMin: 1, UIDRangeMax: 999999}
	sv := spec.Server{UUID: "port-test", UID: os.Getuid(), Limits: spec.Limits{MemoryMB: 512},
		Allocations: []spec.Allocation{{IP: "192.168.1.111", Port: port, Primary: true}}}
	s, err := New(sv, node)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = s.Jail.Close() })
	return s
}

func TestEnsureServerPort_FixesPortCarriedOverFromAnotherNode(t *testing.T) {
	s := newPortTestServer(t, 25665)
	path := filepath.Join(s.Jail.Root(), "server.properties")
	if err := os.WriteFile(path, []byte("level-seed=42\nserver-port=25765\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	s.ensureServerPort()
	got, _ := os.ReadFile(path)
	if string(got) != "level-seed=42\nserver-port=25665\n" {
		t.Fatalf("got %q", got)
	}
}

func TestEnsureServerPort_LeavesSoftwareWithoutServerPropertiesAlone(t *testing.T) {
	s := newPortTestServer(t, 25665)
	s.ensureServerPort()
	if _, err := os.Stat(filepath.Join(s.Jail.Root(), "server.properties")); !os.IsNotExist(err) {
		t.Fatalf("server.properties must not be created for software that has none (proxies), stat err=%v", err)
	}
}

func TestEnsureServerPort_NeverFollowsASymlinkOutOfTheJail(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the openat2-based jail is Linux-only")
	}
	s := newPortTestServer(t, 25665)
	outside := filepath.Join(t.TempDir(), "host-file")
	if err := os.WriteFile(outside, []byte("server-port=1\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(s.Jail.Root(), "server.properties")); err != nil {
		t.Fatal(err)
	}
	s.ensureServerPort()
	got, _ := os.ReadFile(outside)
	if !strings.Contains(string(got), "server-port=1") {
		t.Fatalf("a file outside the jail was modified through a symlink: %q", got)
	}
}
