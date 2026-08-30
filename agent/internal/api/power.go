package api

import (
	"context"
	"fmt"

	"github.com/pxhost/agent/internal/dockerx"
	"github.com/pxhost/agent/internal/srv"
)

// performPower is the single chokepoint every power action goes through,
// whether it arrived via the REST API or the WebSocket protocol. "restart"
// is sequenced here as a graceful stop followed by a start rather than
// Docker's own ContainerRestart, so the agent controls the intermediate
// state reporting (architecture doc 4.3/4.5).
func performPower(ctx context.Context, dc *dockerx.Client, s *srv.Server, action string) error {
	switch action {
	case "start":
		return s.Start(ctx, dc)
	case "stop":
		return s.Stop(ctx, dc)
	case "restart":
		if s.State != srv.StateOffline {
			if err := s.Stop(ctx, dc); err != nil {
				return fmt.Errorf("restart: stop phase: %w", err)
			}
		}
		return s.Start(ctx, dc)
	case "kill":
		return s.Kill(ctx, dc)
	default:
		return fmt.Errorf("api: unknown power action %q", action)
	}
}
