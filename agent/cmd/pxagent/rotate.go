package main

import (
	"flag"
	"fmt"

	"github.com/pxhost/agent/internal/config"
	"github.com/pxhost/agent/internal/panel"
)

// runRotateTokenCmd is the one-shot CLI form of the same self-rotation
// `serve` runs on its own schedule (architecture doc roadmap M13) — see
// runTokenRotationLoop in serve.go for the long-running version and the
// zero-downtime reasoning both share.
func runRotateTokenCmd(args []string) error {
	fs := flag.NewFlagSet("rotate-token", flag.ExitOnError)
	nodePath := fs.String("node", "", "path to node.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *nodePath == "" {
		return fmt.Errorf("usage: pxagent rotate-token --node <node.json>")
	}

	ctx, cancel := signalContext()
	defer cancel()

	_, nf, err := config.LoadNode(*nodePath)
	if err != nil {
		return err
	}
	if nf.NodeToken == "" || nf.PanelURL == "" {
		return fmt.Errorf("node.json: node_token and panel_url are required (has this node been bootstrapped?)")
	}

	client := panel.New(nf.PanelURL)
	resp, err := client.RotateToken(ctx, nf.NodeToken)
	if err != nil {
		return err
	}

	nf.NodeToken = resp.NodeToken
	if err := config.SaveNode(*nodePath, nf); err != nil {
		return err
	}

	fmt.Printf("rotated token for node %s\n", nf.NodeUUID)
	fmt.Printf("wrote new node_token to %s\n", *nodePath)
	return nil
}
