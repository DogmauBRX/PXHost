// Package preflight holds startup checks for conditions the agent cannot
// do its job without, and cannot discover any other way than by trying —
// where "trying" means failing hours later, in an unrelated subsystem,
// with an error that does not name the real cause.
package preflight

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Linux capability bit numbers (uapi/linux/capability.h). Only the three
// the agent actually needs are listed; see RequiredCapabilities.
const (
	capChown       = 0
	capDACOverride = 1
	capFOwner      = 3
)

// Capability pairs a bit with the name an operator would grep for, and
// with the reason it is needed — the error message is the whole point of
// this check, so the reason travels with the bit rather than living in a
// comment far from it.
type Capability struct {
	Bit    uint
	Name   string
	Reason string
}

// RequiredCapabilities is deploy/node/pxagent.service's
// `AmbientCapabilities` line, as data.
//
// The agent runs as the unprivileged `gxhost` user while every server's
// data directory belongs to that server's OWN sandboxed uid — a
// different one per server, none of them `gxhost`. These three are what
// let it keep working on that content anyway.
var RequiredCapabilities = []Capability{
	{capChown, "CAP_CHOWN", "handing a file to a server's own uid — every install script, every file-manager write, every archive extracted during a restore or a node-to-node transfer"},
	{capDACOverride, "CAP_DAC_OVERRIDE", "reading back a file that belongs to a server's uid rather than to the agent"},
	{capFOwner, "CAP_FOWNER", "chmod-ing a file the instant after it was chowned away to a server's uid"},
}

// MissingCapabilities reports which of `required` are absent from the
// effective capability set. Root is exempt: euid 0 is allowed everything
// these capabilities carve out, and a root-run agent legitimately has an
// empty ambient set.
func MissingCapabilities(euid int, capEff uint64, required []Capability) []Capability {
	if euid == 0 {
		return nil
	}
	var missing []Capability
	for _, c := range required {
		if capEff&(1<<c.Bit) == 0 {
			missing = append(missing, c)
		}
	}
	return missing
}

// readEffectiveCaps parses CapEff out of /proc/<pid>/status.
//
// Returns ok=false rather than an error when the value simply is not
// available — a kernel without /proc, a platform that has no
// capabilities at all. "Cannot tell" must never be treated as "missing":
// refusing to start on a system this check does not understand would be
// a worse failure than the one it exists to prevent.
func readEffectiveCaps(statusPath string) (caps uint64, ok bool) {
	raw, err := os.ReadFile(statusPath)
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		rest, found := strings.CutPrefix(line, "CapEff:")
		if !found {
			continue
		}
		v, err := strconv.ParseUint(strings.TrimSpace(rest), 16, 64)
		if err != nil {
			return 0, false
		}
		return v, true
	}
	return 0, false
}

// CheckCapabilities is the startup gate.
//
// It returns an error — the agent refuses to start — rather than logging
// a warning and carrying on, because carrying on is precisely what made
// this expensive. Found live: a second node was brought up with a
// hand-written unit missing the AmbientCapabilities line. The agent
// started, heartbeat as healthy, the panel scheduled a node-to-node
// transfer onto it, and the only symptom was
//
//	extracting archive: backup: preparing ".paper/map-color-cache.dat": operation not permitted
//
// hours later and three subsystems away. A node that cannot chown cannot
// install a server, cannot accept a file upload, and cannot receive a
// transfer — it has nothing useful to offer, and the panel is better off
// seeing it as down than as available-but-silently-broken.
func CheckCapabilities() error {
	capEff, ok := readEffectiveCaps("/proc/self/status")
	if !ok {
		return nil
	}
	missing := MissingCapabilities(os.Geteuid(), capEff, RequiredCapabilities)
	if len(missing) == 0 {
		return nil
	}

	var b strings.Builder
	fmt.Fprintf(&b, "missing required capabilities (running as uid %d):\n", os.Geteuid())
	for _, c := range missing {
		fmt.Fprintf(&b, "  - %s: %s\n", c.Name, c.Reason)
	}
	all := make([]string, 0, len(RequiredCapabilities))
	for _, c := range RequiredCapabilities {
		all = append(all, c.Name)
	}
	fmt.Fprintf(&b, "add this line to the [Service] section of pxagent.service, then "+
		"`systemctl daemon-reload && systemctl restart pxagent`:\n\n"+
		"  AmbientCapabilities=%s\n\n"+
		"see deploy/node/pxagent.service, which has it, and docs/DEPLOY.md for the full node setup",
		strings.Join(all, " "))
	return fmt.Errorf("%s", b.String())
}
