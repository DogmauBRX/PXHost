// Command pxagent is the PXHost Node Agent. M1 scope: a CLI driving the
// Docker container lifecycle (create/start/stop/kill/rm/inspect) for one
// server from local JSON config files, so the container spec builder and
// the Docker client wrapper can be exercised against a real daemon before
// the HTTP API, panel auth, console streaming, or filesystem jail exist
// (architecture doc, milestone M1).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pxhost/agent/internal/config"
	"github.com/pxhost/agent/internal/dockerx"
	"github.com/pxhost/agent/internal/srv"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "pxagent: "+err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		printUsage()
		return fmt.Errorf("no command given")
	}

	switch args[0] {
	case "server":
		return runServerCmd(args[1:])
	case "network":
		return runNetworkCmd(args[1:])
	case "serve":
		return runServeCmd(args[1:])
	case "bootstrap":
		return runBootstrapCmd(args[1:])
	case "rotate-token":
		return runRotateTokenCmd(args[1:])
	case "help", "-h", "--help":
		printUsage()
		return nil
	default:
		printUsage()
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, `pxagent - PXHost Node Agent

Usage:
  pxagent network ensure --node <node.json>
  pxagent server create  --node <node.json> --server <server.json>
  pxagent server start   --server <server.json>
  pxagent server stop    --server <server.json>
  pxagent server kill    --server <server.json>
  pxagent server rm      --server <server.json>
  pxagent server inspect --server <server.json>
  pxagent serve --node <node.json> [--server <server.json> ...] [--autostart]
      Starts the HTTP + WebSocket control API (M2): REST power/status
      endpoints, plus a direct browser<->agent console/stats WebSocket
      authenticated by short-lived panel-signed Ed25519 tokens. If
      node.json has panel_url set (via 'pxagent bootstrap'), also
      heartbeats to the panel on a fixed interval (M4).
  pxagent bootstrap --panel <url> --token <bootstrap-token> --node <node.json>
      Redeems a single-use, admin-issued bootstrap token for a long-lived
      node token (M4), writing node_uuid/node_token/panel_url into
      node.json. Run once per node, before 'pxagent serve'.
  pxagent rotate-token --node <node.json>
      Self-rotation (M13): trades the node's current token for a fresh
      one in one round trip and rewrites node.json. 'serve' also does
      this on its own schedule while running (node.json's
      token_rotation_interval_hours) — this subcommand is the same call,
      run once, for manual/offline rotation or live verification.

Every command connects to the Docker daemon via the standard DOCKER_HOST
resolution (a Unix socket on Linux nodes, a named pipe under Docker Desktop
for local development).`)
}

func runNetworkCmd(args []string) error {
	if len(args) == 0 || args[0] != "ensure" {
		return fmt.Errorf("usage: pxagent network ensure --node <node.json>")
	}
	fs := flag.NewFlagSet("network ensure", flag.ExitOnError)
	nodePath := fs.String("node", "", "path to node.json")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if *nodePath == "" {
		return fmt.Errorf("--node is required")
	}

	ctx, cancel := signalContext()
	defer cancel()

	node, nf, err := config.LoadNode(*nodePath)
	if err != nil {
		return err
	}

	dc, err := dockerx.New(ctx)
	if err != nil {
		return err
	}
	defer dc.Close()

	if err := dc.EnsureNetwork(ctx, node.NetworkName, nf.NetworkSubnet, nf.NetworkGateway); err != nil {
		return err
	}
	fmt.Printf("network %q ready (subnet=%s gateway=%s, enable_icc=false)\n", node.NetworkName, nf.NetworkSubnet, nf.NetworkGateway)
	return nil
}

func runServerCmd(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: pxagent server <create|start|stop|kill|rm|inspect> --server <server.json> [--node <node.json>]")
	}
	sub := args[0]
	fs := flag.NewFlagSet("server "+sub, flag.ExitOnError)
	nodePath := fs.String("node", "", "path to node.json (required for create)")
	serverPath := fs.String("server", "", "path to server.json")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if *serverPath == "" {
		return fmt.Errorf("--server is required")
	}

	ctx, cancel := signalContext()
	defer cancel()

	sv, err := config.LoadServer(*serverPath)
	if err != nil {
		return err
	}

	dc, err := dockerx.New(ctx)
	if err != nil {
		return err
	}
	defer dc.Close()

	switch sub {
	case "create":
		if *nodePath == "" {
			return fmt.Errorf("--node is required for create")
		}
		node, _, err := config.LoadNode(*nodePath)
		if err != nil {
			return err
		}
		// Digest pinning is enforced here at the CLI boundary for real
		// nodes; local/dev images may omit image_digest, in which case
		// PullPinned is a no-op verification (still pulls, just doesn't
		// assert a digest match).
		digest := ""
		if len(sv.Image) > 0 {
			if idx := indexByte(sv.Image, '@'); idx != -1 {
				digest = sv.Image[idx+1:]
			}
		}
		if err := dc.PullPinned(ctx, sv.Image, digest); err != nil {
			return err
		}

		s, err := srv.New(sv, node)
		if err != nil {
			return err
		}
		if err := s.Create(ctx, dc); err != nil {
			return err
		}
		fmt.Printf("created container %s (id=%s) for server %s\n", s.ContainerName, s.ContainerID, s.UUID)
		return nil

	case "start":
		id, err := findContainerID(ctx, dc, sv.UUID)
		if err != nil {
			return err
		}
		if err := dc.StartContainer(ctx, id); err != nil {
			return err
		}
		fmt.Printf("started container %s\n", id)
		return nil

	case "stop":
		id, err := findContainerID(ctx, dc, sv.UUID)
		if err != nil {
			return err
		}
		if err := dc.StopContainer(ctx, id, defaultStopTimeout); err != nil {
			return err
		}
		fmt.Printf("stopped container %s\n", id)
		return nil

	case "kill":
		id, err := findContainerID(ctx, dc, sv.UUID)
		if err != nil {
			return err
		}
		if err := dc.KillContainer(ctx, id); err != nil {
			return err
		}
		fmt.Printf("killed container %s\n", id)
		return nil

	case "rm":
		id, err := findContainerID(ctx, dc, sv.UUID)
		if err != nil {
			return err
		}
		if err := dc.RemoveContainer(ctx, id, true); err != nil {
			return err
		}
		fmt.Printf("removed container %s\n", id)
		return nil

	case "inspect":
		id, err := findContainerID(ctx, dc, sv.UUID)
		if err != nil {
			return err
		}
		insp, err := dc.InspectContainer(ctx, id)
		if err != nil {
			return err
		}
		out, err := json.MarshalIndent(insp, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(out))
		return nil

	default:
		return fmt.Errorf("unknown server subcommand %q", sub)
	}
}

const defaultStopTimeout = 30 * time.Second

func findContainerID(ctx context.Context, dc *dockerx.Client, serverUUID string) (string, error) {
	list, err := dc.ListManaged(ctx)
	if err != nil {
		return "", err
	}
	wantName := "/pxhost-" + serverUUID
	for _, c := range list {
		for _, n := range c.Names {
			if n == wantName {
				return c.ID, nil
			}
		}
	}
	return "", fmt.Errorf("no managed container found for server %s (did you run 'server create'?)", serverUUID)
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}
