package diag

import (
	"net"
	"testing"
)

func TestProbeChecks(t *testing.T) {
	out := "PROBE piston-data.mojang.com ok 404\nPROBE api.modrinth.com fail 000\nPROBE fill.papermc.io ok 000\n"
	checks := ProbeChecks([]string{"piston-data.mojang.com", "api.modrinth.com", "fill.papermc.io", "cdn.modrinth.com"}, out)
	want := []bool{true, false, false, false}
	for i, c := range checks {
		if c.OK != want[i] {
			t.Fatalf("%s: ok=%v, want %v (%s)", c.Key, c.OK, want[i], c.Detail)
		}
	}
	if checks[3].Detail != "sem resultado do container de teste" {
		t.Fatalf("a target missing from the output must fail explicitly, got %q", checks[3].Detail)
	}
}

func TestProbeChecks_ProbeErrorFailsEveryTarget(t *testing.T) {
	checks := ProbeChecks([]string{"a.example", "b.example"}, "PROBE_ERROR curl ausente na imagem\n")
	for _, c := range checks {
		if c.OK || c.Detail != "curl ausente na imagem" {
			t.Fatalf("unexpected %+v", c)
		}
	}
}

func TestMissingLocalIPs(t *testing.T) {
	have := []net.Addr{
		&net.IPNet{IP: net.ParseIP("192.168.1.103"), Mask: net.CIDRMask(24, 32)},
		&net.IPNet{IP: net.ParseIP("10.10.0.4"), Mask: net.CIDRMask(24, 32)},
	}
	got := MissingLocalIPs([]string{"192.168.1.103", "192.168.1.101", "0.0.0.0", "garbage"}, have)
	if len(got) != 1 || got[0] != "192.168.1.101" {
		t.Fatalf("got %v", got)
	}
}

func TestBrokenNameserver(t *testing.T) {
	cases := map[string]string{
		"nameserver 127.0.0.11\noptions ndots:0\n":       "",
		"# generated\nnameserver 127.0.0.53\nsearch .\n": "127.0.0.53",
		"nameserver 192.168.1.1\nnameserver 1.1.1.1\n":   "",
		"nameserver ::1\n": "::1",
	}
	for in, want := range cases {
		if got := BrokenNameserver(in); got != want {
			t.Fatalf("BrokenNameserver(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidHostname(t *testing.T) {
	for _, ok := range []string{"piston-data.mojang.com", "api.modrinth.com"} {
		if !ValidHostname(ok) {
			t.Fatalf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "localhost", "-x.com", "a.com;rm -rf /", "a.com/x", "$(id).com"} {
		if ValidHostname(bad) {
			t.Fatalf("%q should be rejected", bad)
		}
	}
}
