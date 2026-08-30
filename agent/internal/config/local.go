// Package config loads the agent's local, file-based configuration. M1
// only needs the pieces the CLI's create/start/stop/kill commands touch —
// a node profile and a server definition, both plain JSON on disk. The full
// YAML agent config (bootstrap, panel trust, TLS, etc. — architecture doc
// 4.2) lands in a later milestone once the panel exists to bootstrap
// against.
package config

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/pxhost/agent/internal/spec"
)

// NodeFile is the on-disk shape of a node profile for local/dev use.
type NodeFile struct {
	DataDir        string `json:"data_dir"`
	InstallDir     string `json:"install_dir"`
	BackupDir      string `json:"backup_dir"`
	TransferDir    string `json:"transfer_dir"`
	NetworkName    string `json:"network_name"`
	NetworkSubnet  string `json:"network_subnet"`
	NetworkGateway string `json:"network_gateway"`
	CgroupParent   string `json:"cgroup_parent"`
	UIDRangeMin    int    `json:"uid_range_min"`
	UIDRangeMax    int    `json:"uid_range_max"`

	SeccompProfilePath string `json:"seccomp_profile_path"`
	ApparmorProfile    string `json:"apparmor_profile"`
	IOWeightSupported  bool   `json:"io_weight_supported"`

	// --- M2: agent API fields ---
	NodeUUID           string   `json:"node_uuid"`
	NodeToken          string   `json:"node_token"`
	ListenAddr         string   `json:"listen_addr"`
	PanelPublicKeyPath string   `json:"panel_public_key_path"` // base64-encoded raw Ed25519 public key
	WSAllowedOrigins   []string `json:"ws_allowed_origins"`

	// --- M4: panel bootstrap/heartbeat fields ---
	// PanelURL and HeartbeatIntervalSeconds are populated by `pxagent
	// bootstrap` (see cmd/pxagent/bootstrap.go) alongside NodeUUID/
	// NodeToken above; HeartbeatIntervalSeconds falls back to 15 if unset
	// (e.g. a node.json hand-written before ever bootstrapping).
	PanelURL                 string `json:"panel_url"`
	HeartbeatIntervalSeconds int    `json:"heartbeat_interval_seconds"`

	// --- M13: token rotation ---
	// 0 = disabled (the operator relies on `pxagent rotate-token` run
	// manually, or the panel's admin-forced rotation, instead). A real
	// deployment should set this — architecture doc roadmap M13 calls
	// for token rotation as a matter of course, not only in response to
	// a suspected compromise.
	TokenRotationIntervalHours int `json:"token_rotation_interval_hours"`

	LogMaxSize string `json:"log_max_size"`
	LogMaxFile string `json:"log_max_file"`

	MountAllowlist []spec.MountAllowlistEntry `json:"mount_allowlist"`
}

// ServerFile is the on-disk shape of a single server definition for the
// M1 CLI. It maps directly onto spec.Server.
type ServerFile struct {
	UUID         string            `json:"uuid"`
	UID          int               `json:"uid"`
	Image        string            `json:"image"`
	ImageDigest  string            `json:"image_digest"` // sha256:... without the "@"; empty = don't pin (dev only)
	StartupTmpl  string            `json:"startup_template"`
	StopSignal   string            `json:"stop_signal"`
	DeclaredVars []string          `json:"declared_variables"` // the template's allowlist
	Vars         map[string]string `json:"variables"`

	Limits      LimitsFile          `json:"limits"`
	Allocations []spec.Allocation   `json:"allocations"`
	Mounts      []spec.MountRequest `json:"mounts"`
}

type LimitsFile struct {
	CPUPercent int   `json:"cpu_percent"`
	MemoryMB   int64 `json:"memory_mb"`
	SwapMB     int64 `json:"swap_mb"`
	DiskMB     int64 `json:"disk_mb"`
	IOWeight   int   `json:"io_weight"`
	PidsLimit  int64 `json:"pids_limit"`
}

func LoadNode(path string) (spec.Node, NodeFile, error) {
	var nf NodeFile
	b, err := os.ReadFile(path)
	if err != nil {
		return spec.Node{}, nf, fmt.Errorf("config: read node file %q: %w", path, err)
	}
	if err := json.Unmarshal(b, &nf); err != nil {
		return spec.Node{}, nf, fmt.Errorf("config: parse node file %q: %w", path, err)
	}

	seccompJSON := ""
	if nf.SeccompProfilePath != "" {
		sb, err := os.ReadFile(nf.SeccompProfilePath)
		if err != nil {
			return spec.Node{}, nf, fmt.Errorf("config: read seccomp profile %q: %w", nf.SeccompProfilePath, err)
		}
		seccompJSON = string(sb)
	}

	node := spec.Node{
		DataDir:            nf.DataDir,
		InstallDir:         nf.InstallDir,
		BackupDir:          nf.BackupDir,
		TransferDir:        nf.TransferDir,
		NetworkName:        nf.NetworkName,
		CgroupParent:       nf.CgroupParent,
		UIDRangeMin:        nf.UIDRangeMin,
		UIDRangeMax:        nf.UIDRangeMax,
		SeccompProfileJSON: seccompJSON,
		ApparmorProfile:    nf.ApparmorProfile,
		IOWeightSupported:  nf.IOWeightSupported,
		MountAllowlist:     nf.MountAllowlist,
		LogMaxSize:         nf.LogMaxSize,
		LogMaxFile:         nf.LogMaxFile,
	}
	return node, nf, nil
}

// SaveNode writes nf back to path as indented JSON. Used by `pxagent
// bootstrap` to persist the node_uuid/node_token/panel_url it obtains
// from the panel — the rest of the file (network config, security
// profile paths, uid range) is node-local and untouched by bootstrap.
func SaveNode(path string, nf NodeFile) error {
	b, err := json.MarshalIndent(nf, "", "  ")
	if err != nil {
		return fmt.Errorf("config: marshal node file: %w", err)
	}
	if err := os.WriteFile(path, b, 0o640); err != nil {
		return fmt.Errorf("config: write node file %q: %w", path, err)
	}
	return nil
}

func LoadServer(path string) (spec.Server, error) {
	var sf ServerFile
	b, err := os.ReadFile(path)
	if err != nil {
		return spec.Server{}, fmt.Errorf("config: read server file %q: %w", path, err)
	}
	if err := json.Unmarshal(b, &sf); err != nil {
		return spec.Server{}, fmt.Errorf("config: parse server file %q: %w", path, err)
	}

	env, dropped, err := spec.BuildEnv(sf.DeclaredVars, sf.Vars, map[string]string{
		"SERVER_UUID": sf.UUID,
		"HOME":        "/home/container",
		"USER":        "container",
		"TZ":          "UTC",
		"LANG":        "C.UTF-8",
		"TERM":        "xterm",
	})
	if err != nil {
		return spec.Server{}, fmt.Errorf("config: building env for server %s: %w", sf.UUID, err)
	}
	if len(dropped) > 0 {
		fmt.Fprintf(os.Stderr, "warning: server %s: dropped undeclared variables: %v\n", sf.UUID, dropped)
	}

	envMap := make(map[string]string, len(env))
	for _, kv := range env {
		k, v := splitKV(kv)
		envMap[k] = v
	}

	image := sf.Image
	if sf.ImageDigest != "" {
		image = sf.Image + "@" + sf.ImageDigest
	}

	return spec.Server{
		UUID:        sf.UUID,
		UID:         sf.UID,
		Image:       image,
		StartupTmpl: sf.StartupTmpl,
		StopSignal:  sf.StopSignal,
		Env:         envMap,
		Limits: spec.Limits{
			CPUPercent: sf.Limits.CPUPercent,
			MemoryMB:   sf.Limits.MemoryMB,
			SwapMB:     sf.Limits.SwapMB,
			DiskMB:     sf.Limits.DiskMB,
			IOWeight:   sf.Limits.IOWeight,
			PidsLimit:  sf.Limits.PidsLimit,
		},
		Allocations: sf.Allocations,
		Mounts:      sf.Mounts,
	}, nil
}

func splitKV(kv string) (string, string) {
	for i := 0; i < len(kv); i++ {
		if kv[i] == '=' {
			return kv[:i], kv[i+1:]
		}
	}
	return kv, ""
}
