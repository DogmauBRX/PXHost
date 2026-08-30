package srv

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/pxhost/agent/internal/console"
	"github.com/pxhost/agent/internal/spec"
)

const defaultInstallTimeout = 15 * time.Minute

// Install runs the template's install script in a separate, throwaway
// container (architecture doc 3.6): writes the script to a per-server
// path under node.InstallDir (outside the server's own data directory, so
// the customer can never read or modify it, and mounted read-only into
// the installer), builds the tighter install-specific spec, runs it to
// completion, and cleans up.
//
// The install container's output is attached to the SAME console Hub the
// real game server will later use, on s.bgCtx (never the caller's
// request-scoped context — see Start's doc comment for why that
// distinction matters) — a customer who opens the console mid-install
// sees progress in the same terminal, and it's still in the scrollback
// ring afterward.
//
// Returns nil only on a successful (exit 0) install; the caller is
// responsible for the resulting status transition (ready vs
// install_failed) and for reporting it to the panel.
func (s *Server) Install(ctx context.Context, dc dockerFull, image, entrypoint, script string, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = defaultInstallTimeout
	}

	scriptPath, err := s.writeInstallScript(script)
	if err != nil {
		return fmt.Errorf("srv: writing install script: %w", err)
	}
	defer os.RemoveAll(filepath.Dir(scriptPath))

	if err := dc.PullPinned(ctx, image, ""); err != nil {
		return fmt.Errorf("srv: pulling install image: %w", err)
	}

	cfg, hostCfg, netCfg, err := spec.BuildInstallContainerSpec(s.spec, s.node, spec.InstallSpec{
		Image:          image,
		Entrypoint:     entrypoint,
		ScriptHostPath: scriptPath,
	})
	if err != nil {
		return fmt.Errorf("srv: building install spec: %w", err)
	}

	installerName := "pxhost-installer-" + s.UUID
	id, err := dc.CreateContainer(ctx, installerName, cfg, hostCfg, netCfg)
	if err != nil {
		return fmt.Errorf("srv: creating install container: %w", err)
	}
	defer func() {
		// Force-remove regardless of outcome: an installer container is
		// never adopted or reused across runs, unlike the game container.
		_ = dc.RemoveContainer(context.Background(), id, true)
	}()

	// Attach BEFORE start, same rule as Start() — the whole point is to
	// capture output from the very first line.
	pump, err := console.Start(s.bgCtx, dc, id, s.Hub)
	if err != nil {
		return fmt.Errorf("srv: attaching to install container: %w", err)
	}
	defer pump.Close()

	if err := dc.StartContainer(ctx, id); err != nil {
		return fmt.Errorf("srv: starting install container: %w", err)
	}

	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	exitCode, err := dc.WaitContainer(waitCtx, id)
	if err != nil {
		return fmt.Errorf("srv: install did not complete within %s: %w", timeout, err)
	}
	if exitCode != 0 {
		return fmt.Errorf("srv: install script exited %d", exitCode)
	}
	return nil
}

// writeInstallScript writes script to
// <node.InstallDir>/<uuid>/install.sh and returns that path. 0500: the
// server's own uid may read+execute it (the install container runs as
// that uid), nothing else can — it lives outside the bind-mounted data
// directory specifically so the customer's own running container (which
// only ever sees /home/container) has no path to it at all.
func (s *Server) writeInstallScript(script string) (string, error) {
	dir := filepath.Join(s.node.InstallDir, s.UUID)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "install.sh")
	if err := os.WriteFile(path, []byte(script), 0o500); err != nil {
		return "", err
	}
	if err := os.Chown(path, s.spec.UID, s.spec.UID); err != nil {
		// Best-effort: chown requires root/CAP_CHOWN and fails harmlessly
		// on non-Linux dev environments (Docker Desktop on Windows).
		// Real Linux nodes run the agent with CAP_CHOWN per its systemd
		// unit (architecture doc 4.2), where this succeeds.
		_ = err
	}
	return path, nil
}
