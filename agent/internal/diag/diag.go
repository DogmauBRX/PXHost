// Package diag holds the pure parts of the node self-diagnostics the panel
// runs on demand: what to execute inside the probe container, how to read
// its output, and the host-side checks that need no Docker round trip.
package diag

import (
	"bufio"
	"fmt"
	"net"
	"regexp"
	"strings"
)

type Check struct {
	Key        string `json:"key"`
	OK         bool   `json:"ok"`
	Detail     string `json:"detail"`
	DurationMs int64  `json:"durationMs"`
}

var hostnamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)

// ValidHostname gates what reaches the probe's argv. The script never
// interpolates its arguments into a command line, but a hostname is all a
// target ever needs to be.
func ValidHostname(h string) bool {
	return len(h) <= 253 && hostnamePattern.MatchString(h)
}

// ProbeScript runs as `sh -c ProbeScript probe <host>...`. It resolves each
// host the way the JVM does (glibc getaddrinfo) and then opens HTTPS to it;
// any HTTP status, even 404, proves DNS and egress both work.
const ProbeScript = `command -v curl >/dev/null 2>&1 || { echo "PROBE_ERROR curl ausente na imagem"; exit 0; }
for h in "$@"; do
  if getent ahostsv4 "$h" >/dev/null 2>&1; then dns=ok; else dns=fail; fi
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "https://$h/" 2>/dev/null)
  echo "PROBE $h $dns ${code:-000}"
done`

type targetResult struct {
	dnsOK    bool
	httpCode string
}

// ProbeChecks turns the probe's stdout into one check per requested target.
// A target missing from the output is reported as failed rather than
// silently dropped, since that is what a probe killed mid-run looks like.
func ProbeChecks(targets []string, output string) []Check {
	results := map[string]targetResult{}
	probeErr := ""
	sc := bufio.NewScanner(strings.NewReader(output))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if rest, ok := strings.CutPrefix(line, "PROBE_ERROR "); ok {
			probeErr = rest
			continue
		}
		f := strings.Fields(line)
		if len(f) == 4 && f[0] == "PROBE" {
			results[f[1]] = targetResult{dnsOK: f[2] == "ok", httpCode: f[3]}
		}
	}

	checks := make([]Check, 0, len(targets))
	for _, host := range targets {
		key := "egress:" + host
		r, ok := results[host]
		switch {
		case probeErr != "":
			checks = append(checks, Check{Key: key, Detail: probeErr})
		case !ok:
			checks = append(checks, Check{Key: key, Detail: "sem resultado do container de teste"})
		case !r.dnsOK:
			checks = append(checks, Check{Key: key, Detail: "DNS não resolve dentro do container"})
		case r.httpCode == "000":
			checks = append(checks, Check{Key: key, Detail: "DNS ok, mas sem conexão HTTPS"})
		default:
			checks = append(checks, Check{Key: key, OK: true, Detail: "DNS e HTTPS ok (HTTP " + r.httpCode + ")"})
		}
	}
	return checks
}

// MissingLocalIPs returns the wanted IPs not assigned to any local
// interface. Docker publishes a game port on its allocation's IP, so an IP
// the host no longer has makes every container using it fail to start.
func MissingLocalIPs(want []string, have []net.Addr) []string {
	local := map[string]bool{}
	for _, a := range have {
		if ipn, ok := a.(*net.IPNet); ok {
			local[ipn.IP.String()] = true
		}
	}
	var missing []string
	for _, w := range want {
		ip := net.ParseIP(strings.TrimSpace(w))
		if ip == nil || ip.IsUnspecified() {
			continue
		}
		if !local[ip.String()] {
			missing = append(missing, ip.String())
		}
	}
	return missing
}

// BrokenNameserver returns the first nameserver in a container's
// resolv.conf that points at loopback other than Docker's embedded DNS.
// Inside the container's own network namespace nothing listens there, so
// every lookup fails — seen live when a container created mid-IP-change
// was frozen with the host's systemd-resolved stub (127.0.0.53).
func BrokenNameserver(resolvConf string) string {
	sc := bufio.NewScanner(strings.NewReader(resolvConf))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 || f[0] != "nameserver" {
			continue
		}
		ip := net.ParseIP(f[1])
		if ip != nil && ip.IsLoopback() && f[1] != "127.0.0.11" {
			return f[1]
		}
	}
	return ""
}

func FormatList(items []string, max int) string {
	if len(items) <= max {
		return strings.Join(items, ", ")
	}
	return fmt.Sprintf("%s e mais %d", strings.Join(items[:max], ", "), len(items)-max)
}
