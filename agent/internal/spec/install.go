package spec

import (
	"fmt"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/strslice"
)

// InstallSpec is the (non-template) input BuildInstallContainerSpec needs
// beyond Server/Node — the template's install image/entrypoint/script are
// resolved by the panel and passed down per-install, never stored as part
// of the game server's own running spec.
type InstallSpec struct {
	Image      string // panel-resolved, allowlisted; digest pinning optional (admin-authored images)
	Entrypoint string // e.g. "bash" — combined with ScriptHostPath into a two-element, non-interpolated argv
	// ScriptHostPath is the absolute host path (already resolved under
	// node.InstallDir) the caller has written the template's install
	// script to, before calling this function. Mounted read-only.
	ScriptHostPath string
}

const (
	installMemoryCeilingMB = 1024
	installCPUPercent      = 100
	installPidsLimit       = 256
)

// BuildInstallContainerSpec builds the throwaway container that runs a
// template's install script (architecture doc 3.6). It shares most of
// BuildContainerSpec's security posture — dropped capabilities, no
// privileged mode, no new privileges, seccomp/AppArmor, no Docker socket,
// own namespaces — but differs in three deliberate ways:
//
//  1. The rootfs is NOT read-only: installers legitimately need /tmp and
//     package-manager caches. Nothing outside the bind mounts survives
//     the container anyway, since it's removed after running.
//  2. Limits are tighter and INDEPENDENT of the server's own plan limits
//     (min(server memory, 1 GiB), 100% CPU, 256 pids) — an install script
//     is admin-authored, not customer-controlled, but it still shouldn't
//     be able to consume the server's full entitlement while installing,
//     and a customer's plan could be tiny (128 MB) which would make a
//     real installer (unzip, jar verification) OOM immediately.
//  3. Entrypoint is exactly [Entrypoint, "/mnt/install/install.sh"] — a
//     CONSTANT two-element argv, never touched by substitution. This is
//     the one place in the agent where argv[0] is allowed to be a shell
//     interpreter (e.g. "bash"): the script it runs is admin-authored
//     template content, not customer input, so there is nothing for a
//     customer-supplied value to inject INTO — customer variables only
//     ever reach the script as environment variables (via env, built the
//     same BuildEnv-allowlisted way as the real server container).
func BuildInstallContainerSpec(srv Server, node Node, install InstallSpec) (*container.Config, *container.HostConfig, *network.NetworkingConfig, error) {
	if err := validateServer(srv, node); err != nil {
		return nil, nil, nil, err
	}
	if install.Image == "" || install.Entrypoint == "" || install.ScriptHostPath == "" {
		return nil, nil, nil, fmt.Errorf("spec: install image, entrypoint, and script path are all required")
	}

	cfg := &container.Config{
		Image:        install.Image,
		Entrypoint:   strslice.StrSlice{install.Entrypoint, "/mnt/install/install.sh"},
		WorkingDir:   "/mnt/server",
		User:         fmt.Sprintf("%d:%d", srv.UID, srv.UID),
		Tty:          false,
		OpenStdin:    false,
		AttachStdin:  false,
		AttachStdout: true,
		AttachStderr: true,
		Healthcheck:  &container.HealthConfig{Test: []string{"NONE"}},
		Labels: map[string]string{
			"pxhost.managed":     "true",
			"pxhost.server.uuid": srv.UUID,
			"pxhost.role":        "installer",
		},
	}

	env, _, err := BuildEnv(nil, nil, srv.Env) // srv.Env already carries the fully-resolved (declared ∪ injected) set by the time this is called
	if err != nil {
		return nil, nil, nil, fmt.Errorf("spec: building install env: %w", err)
	}
	cfg.Env = env

	dataMount, err := BuildDataMount(node, srv)
	if err != nil {
		return nil, nil, nil, err
	}
	dataMount.Target = "/mnt/server"

	scriptMount := Mount{
		Source:       install.ScriptHostPath,
		Target:       "/mnt/install/install.sh",
		ReadOnly:     true,
		NonRecursive: true,
	}

	memBytes := clampInt64(srv.Limits.MemoryMB, 1, installMemoryCeilingMB) * 1024 * 1024
	pidsLimit := int64(installPidsLimit)

	securityOpt := []string{"no-new-privileges:true"}
	if node.SeccompProfileJSON != "" {
		securityOpt = append(securityOpt, "seccomp="+node.SeccompProfileJSON)
	}
	if node.ApparmorProfile != "" {
		securityOpt = append(securityOpt, "apparmor="+node.ApparmorProfile)
	}

	hc := &container.HostConfig{
		Privileged:     false,
		NetworkMode:    container.NetworkMode(node.NetworkName), // installers legitimately need egress to download the game server
		IpcMode:        container.IPCModePrivate,
		CgroupnsMode:   container.CgroupnsModePrivate,
		ReadonlyRootfs: false, // deliberately writable — see doc comment above
		SecurityOpt:    securityOpt,
		CapDrop:        strslice.StrSlice{"ALL"},
		CapAdd:         strslice.StrSlice{},
		Mounts:         []mount.Mount{toDockerMount(dataMount), toDockerMount(scriptMount)},
		RestartPolicy:  container.RestartPolicy{Name: "no"},
		AutoRemove:     false, // removed explicitly by the caller after exit code + logs are captured
		LogConfig: container.LogConfig{
			Type: "local",
			// The "local" driver defaults compress=true, which Docker
			// rejects outright when max-file=1 ("compression cannot be
			// enabled when max file count is 1" — there's nothing to
			// rotate into). A single-file install log has nothing worth
			// compressing anyway, so disable it explicitly rather than
			// bumping max-file just to satisfy the constraint.
			Config: map[string]string{"max-size": "8m", "max-file": "1", "compress": "false"},
		},
		Resources: container.Resources{
			CgroupParent:      node.CgroupParent,
			Memory:            memBytes,
			MemoryReservation: memBytes * 9 / 10,
			MemorySwap:        memBytes,
			MemorySwappiness:  int64Ptr(0),
			OomKillDisable:    boolPtr(false),
			CPUPeriod:         100000,
			CPUQuota:          installCPUPercent * 1000,
			PidsLimit:         &pidsLimit,
			Ulimits: []*container.Ulimit{
				{Name: "nofile", Soft: 4096, Hard: 4096},
				{Name: "nproc", Soft: installPidsLimit, Hard: installPidsLimit},
			},
		},
	}

	netCfg := &network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{node.NetworkName: {}},
	}

	return cfg, hc, netCfg, nil
}

func clampInt64(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
