package spec

import (
	"fmt"
	"path"
	"strings"
)

// Mount is the sanitized, ready-to-use mount description the caller passes
// into the Docker API (as a mount.Mount in the real client wrapper — kept
// as a plain struct here so this package has no Docker SDK dependency).
type Mount struct {
	Source       string
	Target       string
	ReadOnly     bool
	NonRecursive bool
}

// socketLikeSuffixes / forbiddenSourcePrefixes guard against ever handing
// Docker a mount that reaches the container/docker socket or core host
// directories. Mounting the Docker socket into a container is equivalent
// to granting that container root on the host (architecture doc 4.3).
var forbiddenSourcePrefixes = []string{
	"/proc", "/sys", "/dev", "/run", "/etc", "/var/run",
}

func looksLikeControlSocket(p string) bool {
	base := path.Base(p)
	for _, s := range []string{"docker.sock", "containerd.sock", "crio.sock"} {
		if base == s {
			return true
		}
	}
	return strings.HasSuffix(p, ".sock")
}

// BuildDataMount returns the single, mandatory bind mount every server
// container gets: its own data directory to /home/container. It is always
// exactly one mount, non-recursive, and private propagation — an admin
// extra mount is never allowed to be the primary data mount.
func BuildDataMount(node Node, server Server) (Mount, error) {
	if node.DataDir == "" {
		return Mount{}, fmt.Errorf("spec: node.DataDir is empty")
	}
	if server.UUID == "" {
		return Mount{}, fmt.Errorf("spec: server.UUID is empty")
	}
	src := path.Join(node.DataDir, server.UUID)
	if looksLikeControlSocket(src) {
		return Mount{}, fmt.Errorf("spec: refusing to build a data mount that resolves to a control socket")
	}
	return Mount{Source: src, Target: "/home/container", ReadOnly: false, NonRecursive: true}, nil
}

// BuildExtraMounts validates each panel-requested mount against the
// node-local allowlist and returns only the ones that pass every check.
// The panel's request alone is NEVER sufficient authorization — admins
// configure the allowlist directly on the node (architecture doc 4.3),
// so a compromised or buggy panel cannot mount arbitrary host paths.
func BuildExtraMounts(node Node, requests []MountRequest) ([]Mount, []string, error) {
	var out []Mount
	var rejected []string

	for _, req := range requests {
		reason := validateMountRequest(node, req)
		if reason != "" {
			rejected = append(rejected, fmt.Sprintf("%s -> %s: %s", req.Source, req.Target, reason))
			continue
		}
		ro := req.ReadOnly
		out = append(out, Mount{Source: req.Source, Target: req.Target, ReadOnly: ro, NonRecursive: true})
	}
	return out, rejected, nil
}

func validateMountRequest(node Node, req MountRequest) string {
	if looksLikeControlSocket(req.Source) {
		return "source resolves to a control socket"
	}
	for _, forbidden := range forbiddenSourcePrefixes {
		if req.Source == forbidden || strings.HasPrefix(req.Source, forbidden+"/") {
			return fmt.Sprintf("source is under forbidden host path %q", forbidden)
		}
	}
	if !strings.HasPrefix(req.Target, "/home/container") {
		return "target must be under /home/container"
	}

	var entry *MountAllowlistEntry
	for i := range node.MountAllowlist {
		if node.MountAllowlist[i].Source == req.Source {
			entry = &node.MountAllowlist[i]
			break
		}
	}
	if entry == nil {
		return "source is not in the node's mount allowlist (exact match required, no globbing)"
	}
	targetOK := false
	for _, t := range entry.Targets {
		if t == req.Target {
			targetOK = true
			break
		}
	}
	if !targetOK {
		return "target is not one of the allowlisted targets for this source"
	}
	if entry.ReadOnlyRequired && !req.ReadOnly {
		return "this source is allowlisted read-only-only; request must set ReadOnly=true"
	}
	return ""
}
