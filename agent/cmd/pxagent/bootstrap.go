package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"

	"github.com/pxhost/agent/internal/config"
	"github.com/pxhost/agent/internal/dockerx"
	"github.com/pxhost/agent/internal/panel"
)

// runBootstrapCmd redeems a single-use, admin-issued bootstrap token for a
// long-lived node token (architecture doc 4.2/7), then writes node_uuid,
// node_token, panel_url, and heartbeat_interval_seconds into the target
// node.json — merging with whatever node-local config (network, security
// profiles, uid range) already exists there. Run this once per node,
// before `pxagent serve`.
func runBootstrapCmd(args []string) error {
	fs := flag.NewFlagSet("bootstrap", flag.ExitOnError)
	panelURL := fs.String("panel", "", "panel base URL, e.g. http://localhost:3000")
	token := fs.String("token", "", "bootstrap token issued by an admin in the panel")
	nodePath := fs.String("node", "", "path to node.json (created if missing)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *panelURL == "" || *token == "" || *nodePath == "" {
		return fmt.Errorf("usage: pxagent bootstrap --panel <url> --token <bootstrap-token> --node <node.json>")
	}

	ctx, cancel := signalContext()
	defer cancel()

	hostname, _ := os.Hostname()
	dockerVersion := ""
	if dc, err := dockerx.New(ctx); err == nil {
		if v, err := dc.Version(ctx); err == nil {
			dockerVersion = v
		}
		_ = dc.Close()
	}

	client := panel.New(*panelURL)
	resp, err := client.Bootstrap(ctx, panel.BootstrapRequest{
		Token:         *token,
		Hostname:      hostname,
		OS:            runtime.GOOS,
		DockerVersion: dockerVersion,
		Arch:          runtime.GOARCH,
	})
	if err != nil {
		return err
	}

	// Load the existing file if present (preserving node-local settings
	// like network/security config); otherwise start from a zero value —
	// the operator still needs to fill in data_dir/network/uid range
	// before `serve` will start cleanly, same as any hand-written node.json.
	var nf config.NodeFile
	if _, statErr := os.Stat(*nodePath); statErr == nil {
		_, loaded, loadErr := config.LoadNode(*nodePath)
		if loadErr != nil {
			return fmt.Errorf("bootstrap: reading existing %s: %w", *nodePath, loadErr)
		}
		nf = loaded
	}

	nf.NodeUUID = resp.NodeUUID
	nf.NodeToken = resp.NodeToken
	nf.PanelURL = *panelURL
	nf.HeartbeatIntervalSeconds = resp.HeartbeatIntervalSeconds

	if err := config.SaveNode(*nodePath, nf); err != nil {
		return err
	}

	fmt.Printf("bootstrapped node %s\n", resp.NodeUUID)
	fmt.Printf("wrote node_uuid, node_token, panel_url to %s\n", *nodePath)
	fmt.Printf("heartbeat interval: %ds\n", resp.HeartbeatIntervalSeconds)
	return nil
}
