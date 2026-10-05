package spec

import (
	"fmt"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/strslice"
)

const (
	probeMemoryMB  = 128
	probePidsLimit = 64
)

// ProbeRoleLabel marks the throwaway diagnostics container. It deliberately
// carries no gxhost.managed label: boot reconciliation rebuilds a server
// from every managed container it finds.
const ProbeRoleLabel = "probe"

// BuildProbeContainerSpec describes a short-lived container that runs cmd
// under the same isolation a game container gets (node network, read-only
// rootfs, no capabilities, seccomp/apparmor, unprivileged uid), so a
// network check from inside it sees exactly what a customer's server sees.
func BuildProbeContainerSpec(node Node, image string, cmd []string) (*container.Config, *container.HostConfig, *network.NetworkingConfig, error) {
	if image == "" {
		return nil, nil, nil, fmt.Errorf("spec: probe image is empty")
	}
	if node.NetworkName == "" {
		return nil, nil, nil, fmt.Errorf("spec: node network name is empty")
	}
	if node.UIDRangeMin <= 0 {
		return nil, nil, nil, fmt.Errorf("spec: node uid range is not configured")
	}

	cfg := &container.Config{
		Image:        image,
		Entrypoint:   strslice.StrSlice(cmd),
		User:         fmt.Sprintf("%d:%d", node.UIDRangeMin, node.UIDRangeMin),
		WorkingDir:   "/tmp",
		AttachStdout: true,
		AttachStderr: true,
		Healthcheck:  &container.HealthConfig{Test: []string{"NONE"}},
		Labels:       map[string]string{"gxhost.role": ProbeRoleLabel},
	}

	securityOpt := []string{"no-new-privileges:true"}
	if node.SeccompProfileJSON != "" {
		securityOpt = append(securityOpt, "seccomp="+node.SeccompProfileJSON)
	}
	if node.ApparmorProfile != "" {
		securityOpt = append(securityOpt, "apparmor="+node.ApparmorProfile)
	}

	memBytes := int64(probeMemoryMB) * 1024 * 1024
	pids := int64(probePidsLimit)
	hc := &container.HostConfig{
		NetworkMode:    container.NetworkMode(node.NetworkName),
		IpcMode:        container.IPCModePrivate,
		CgroupnsMode:   container.CgroupnsModePrivate,
		ReadonlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,noexec,nosuid,nodev,size=16m,mode=1777"},
		SecurityOpt:    securityOpt,
		CapDrop:        strslice.StrSlice{"ALL"},
		CapAdd:         strslice.StrSlice{},
		RestartPolicy:  container.RestartPolicy{Name: "no"},
		LogConfig: container.LogConfig{
			Type:   "local",
			Config: map[string]string{"max-size": "1m", "max-file": "1", "compress": "false"},
		},
		Resources: container.Resources{
			CgroupParent: node.CgroupParent,
			Memory:       memBytes,
			MemorySwap:   memBytes,
			CPUPeriod:    100000,
			CPUQuota:     50000,
			PidsLimit:    &pids,
		},
	}

	netCfg := &network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{node.NetworkName: {}},
	}
	return cfg, hc, netCfg, nil
}
