// Package dockerx wraps the official Docker Engine API client with the
// narrow surface the agent actually needs, plus the two policies that
// matter for security and reliability: digest-verified image pulls and a
// pinned, non-negotiated API version.
package dockerx

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
)

// pinnedAPIVersion is negotiated once at startup, never renegotiated per
// call — the architecture doc calls for a pinned API version so the agent's
// behavior cannot silently shift under a daemon upgrade.
const pinnedAPIVersion = "1.43"

// ManagedLabel is set on every container the agent creates and is the
// filter used for both the Docker event stream and boot-time reconciliation
// (architecture doc 4.2/4.3).
const ManagedLabel = "pxhost.managed"

type Client struct {
	cli *client.Client
}

// New connects to the Docker daemon using the standard DOCKER_HOST/
// environment resolution (so the same binary works against a Unix socket on
// a real node and a named pipe under Docker Desktop during local dev), and
// pins the API version rather than negotiating it per request.
func New(ctx context.Context) (*Client, error) {
	cli, err := client.NewClientWithOpts(
		client.FromEnv,
		client.WithVersion(pinnedAPIVersion),
	)
	if err != nil {
		return nil, fmt.Errorf("dockerx: connect: %w", err)
	}
	c := &Client{cli: cli}
	if err := c.Ping(ctx); err != nil {
		_ = cli.Close()
		return nil, err
	}
	return c, nil
}

func (c *Client) Close() error { return c.cli.Close() }

func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := c.cli.Ping(ctx); err != nil {
		return fmt.Errorf("dockerx: ping: %w", err)
	}
	return nil
}

// EnsureNetwork creates the node-wide bridge if it does not already exist,
// with enable_icc=false so containers cannot reach each other — the
// architecture's chosen alternative to one network per server (4.3).
// It is idempotent: safe to call on every boot.
func (c *Client) EnsureNetwork(ctx context.Context, name, subnet, gateway string) error {
	list, err := c.cli.NetworkList(ctx, network.ListOptions{
		Filters: filters.NewArgs(filters.Arg("name", name)),
	})
	if err != nil {
		return fmt.Errorf("dockerx: list networks: %w", err)
	}
	for _, n := range list {
		if n.Name == name {
			return nil // already exists; a drifted config is a startup preflight concern, not this call's job
		}
	}

	_, err = c.cli.NetworkCreate(ctx, name, network.CreateOptions{
		Driver: "bridge",
		IPAM: &network.IPAM{
			Config: []network.IPAMConfig{{Subnet: subnet, Gateway: gateway}},
		},
		Options: map[string]string{
			"com.docker.network.bridge.enable_icc":           "false",
			"com.docker.network.bridge.enable_ip_masquerade": "true",
			"com.docker.network.bridge.name":                 name,
		},
		EnableIPv6: boolPtrFalse(),
	})
	if err != nil {
		return fmt.Errorf("dockerx: create network %q: %w", name, err)
	}
	return nil
}

func boolPtrFalse() *bool { b := false; return &b }

// PullPinned pulls an image and verifies the resulting RepoDigests contain
// the digest that was requested — never trusting the pull to have returned
// what was asked for (architecture doc 4.3).
func (c *Client) PullPinned(ctx context.Context, ref string, wantDigest string) error {
	rc, err := c.cli.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("dockerx: pull %q: %w", ref, err)
	}
	defer rc.Close()
	if _, err := io.Copy(io.Discard, rc); err != nil {
		return fmt.Errorf("dockerx: pull %q: reading progress stream: %w", ref, err)
	}

	if wantDigest == "" {
		return nil // digest pinning not required by this call's caller (e.g. install images may be tag-based)
	}
	insp, err := c.cli.ImageInspect(ctx, ref)
	if err != nil {
		return fmt.Errorf("dockerx: inspect %q after pull: %w", ref, err)
	}
	for _, d := range insp.RepoDigests {
		if hasDigestSuffix(d, wantDigest) {
			return nil
		}
	}
	return fmt.Errorf("dockerx: pulled image %q digest mismatch: none of %v match requested %q", ref, insp.RepoDigests, wantDigest)
}

func hasDigestSuffix(repoDigest, digest string) bool {
	// repoDigest looks like "ghcr.io/pxhost/java@sha256:abcd..."
	at := len(repoDigest) - len(digest)
	return at >= 0 && repoDigest[at:] == digest
}

// CreateContainer creates (without starting) a container from an
// already-built spec (see internal/spec). It never accepts raw
// server/template input — only the pure spec output — so this package
// cannot itself become an injection surface.
func (c *Client) CreateContainer(ctx context.Context, name string, cfg *container.Config, hostCfg *container.HostConfig, netCfg *network.NetworkingConfig) (string, error) {
	resp, err := c.cli.ContainerCreate(ctx, cfg, hostCfg, netCfg, nil, name)
	if err != nil {
		return "", fmt.Errorf("dockerx: create container %q: %w", name, err)
	}
	return resp.ID, nil
}

func (c *Client) StartContainer(ctx context.Context, id string) error {
	if err := c.cli.ContainerStart(ctx, id, container.StartOptions{}); err != nil {
		return fmt.Errorf("dockerx: start container %s: %w", id, err)
	}
	return nil
}

// StopContainer sends the stop signal and waits up to timeout before Docker
// escalates to SIGKILL. The caller (srv.Server) is responsible for writing
// a graceful in-game stop command to stdin first, per template config —
// this method is the Docker-level stop only.
func (c *Client) StopContainer(ctx context.Context, id string, timeout time.Duration) error {
	sec := int(timeout.Seconds())
	if err := c.cli.ContainerStop(ctx, id, container.StopOptions{Timeout: &sec}); err != nil {
		return fmt.Errorf("dockerx: stop container %s: %w", id, err)
	}
	return nil
}

func (c *Client) KillContainer(ctx context.Context, id string) error {
	if err := c.cli.ContainerKill(ctx, id, "SIGKILL"); err != nil {
		return fmt.Errorf("dockerx: kill container %s: %w", id, err)
	}
	return nil
}

func (c *Client) RemoveContainer(ctx context.Context, id string, force bool) error {
	if err := c.cli.ContainerRemove(ctx, id, container.RemoveOptions{Force: force}); err != nil {
		return fmt.Errorf("dockerx: remove container %s: %w", id, err)
	}
	return nil
}

// UpdateContainer applies new cgroup limits live, without recreating or
// restarting the container (architecture doc 2.1/9's plan-apply: "admins
// get ... an explicit 'apply to N servers' job" — this is what makes
// that job actually take effect on an already-running server instead of
// only updating the panel's own database row). Docker allows this on
// both a running and a stopped container; a stopped one just picks up
// the new limits the next time it's started.
func (c *Client) UpdateContainer(ctx context.Context, id string, resources container.Resources) error {
	if _, err := c.cli.ContainerUpdate(ctx, id, container.UpdateConfig{Resources: resources}); err != nil {
		return fmt.Errorf("dockerx: update container %s: %w", id, err)
	}
	return nil
}

func (c *Client) InspectContainer(ctx context.Context, id string) (container.InspectResponse, error) {
	insp, err := c.cli.ContainerInspect(ctx, id)
	if err != nil {
		return container.InspectResponse{}, fmt.Errorf("dockerx: inspect container %s: %w", id, err)
	}
	return insp, nil
}

// ListManaged returns every container carrying the pxhost.managed=true
// label — used by boot reconciliation to rebuild in-memory state from
// Docker's own durable labels (architecture doc 4.1).
func (c *Client) ListManaged(ctx context.Context) ([]container.Summary, error) {
	list, err := c.cli.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: filters.NewArgs(filters.Arg("label", ManagedLabel+"=true")),
	})
	if err != nil {
		return nil, fmt.Errorf("dockerx: list managed containers: %w", err)
	}
	return list, nil
}

// Events returns the raw Docker event channel, pre-filtered to managed
// containers, plus an error channel. The caller owns reconnect/backoff.
func (c *Client) Events(ctx context.Context) (<-chan events.Message, <-chan error) {
	f := filters.NewArgs(filters.Arg("label", ManagedLabel+"=true"))
	return c.cli.Events(ctx, events.ListOptions{Filters: f})
}

// AttachIO attaches to a running container's stdin/stdout/stderr. The
// container MUST have been created with Tty:false (spec.BuildContainerSpec
// always sets this) so the returned stream is Docker's multiplexed
// stdcopy framing rather than a raw merged TTY stream — merging streams
// would both lose the stdout/stderr distinction and let the game process
// inject terminal escape sequences straight into whatever renders the
// console (architecture doc 4.5).
func (c *Client) AttachIO(ctx context.Context, id string) (types.HijackedResponse, error) {
	resp, err := c.cli.ContainerAttach(ctx, id, container.AttachOptions{
		Stream: true, Stdin: true, Stdout: true, Stderr: true,
	})
	if err != nil {
		return types.HijackedResponse{}, fmt.Errorf("dockerx: attach to container %s: %w", id, err)
	}
	return resp, nil
}

// ContainerLogs returns the last n lines of a container's log, used to
// backfill the console ring buffer on agent start/reconnect so a
// reconnecting client isn't staring at a blank terminal.
func (c *Client) ContainerLogs(ctx context.Context, id string, tail string) (io.ReadCloser, error) {
	rc, err := c.cli.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Tail: tail,
	})
	if err != nil {
		return nil, fmt.Errorf("dockerx: logs for container %s: %w", id, err)
	}
	return rc, nil
}

// StatsStream opens Docker's long-lived streaming stats endpoint for one
// container. Architecture doc 4.5 is explicit that this must be one
// long-lived stream per running container rather than a per-tick
// `docker stats`-style poll — the latter costs ~10ms of daemon time per
// call and stops scaling past roughly 20 containers on a node.
func (c *Client) StatsStream(ctx context.Context, id string) (io.ReadCloser, error) {
	resp, err := c.cli.ContainerStats(ctx, id, true)
	if err != nil {
		return nil, fmt.Errorf("dockerx: stats stream for container %s: %w", id, err)
	}
	return resp.Body, nil
}

// Version returns the connected Docker daemon's version string, used to
// populate the `dockerVersion` field the agent reports on bootstrap and
// every heartbeat (architecture doc 4.2/7).
func (c *Client) Version(ctx context.Context) (string, error) {
	v, err := c.cli.ServerVersion(ctx)
	if err != nil {
		return "", fmt.Errorf("dockerx: server version: %w", err)
	}
	return v.Version, nil
}

// SystemInfo is the narrow subset of the daemon's `/info` response the
// heartbeat's telemetry (capacity plan Fase 7) actually needs — never the
// full system.Info, which carries daemon config that has no business
// leaving the node.
type SystemInfo struct {
	MemTotalBytes     int64
	NCPU              int
	OperatingSystem   string
	KernelVersion     string
	ContainersRunning int
}

// Info reports what the Docker daemon sees of its OWN host — the agent
// runs directly on the Proxmox host (capacity plan's Fase 0 topology
// decision), so this is genuinely the physical machine's numbers, not a
// container's. Distinct from, and never copied into, the admin's
// DECLARED commercial capacity (Node.memoryTotalMb etc.) — see the
// panel-side `reported_*` columns' own doc comment for why that
// separation is load-bearing.
func (c *Client) Info(ctx context.Context) (SystemInfo, error) {
	info, err := c.cli.Info(ctx)
	if err != nil {
		return SystemInfo{}, fmt.Errorf("dockerx: info: %w", err)
	}
	return SystemInfo{
		MemTotalBytes:     info.MemTotal,
		NCPU:              info.NCPU,
		OperatingSystem:   info.OperatingSystem,
		KernelVersion:     info.KernelVersion,
		ContainersRunning: info.ContainersRunning,
	}, nil
}

// WaitContainer blocks until the container exits (or ctx is cancelled —
// callers are expected to pass a context.WithTimeout for install runs, per
// architecture doc 3.6's hard wall-clock timeout on installers) and
// returns its exit code.
func (c *Client) WaitContainer(ctx context.Context, id string) (exitCode int64, err error) {
	statusCh, errCh := c.cli.ContainerWait(ctx, id, container.WaitConditionNotRunning)
	select {
	case err := <-errCh:
		return 0, fmt.Errorf("dockerx: wait for container %s: %w", id, err)
	case status := <-statusCh:
		return status.StatusCode, nil
	case <-ctx.Done():
		return 0, fmt.Errorf("dockerx: wait for container %s: %w", id, ctx.Err())
	}
}
