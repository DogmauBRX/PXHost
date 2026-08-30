package srv

import (
	"context"
	"errors"
)

// ErrServerSuspended is returned by Start when the server is suspended —
// a distinct sentinel so the HTTP layer can map it to 409 Conflict,
// same pattern as ErrServerNotStopped.
var ErrServerSuspended = errors.New("srv: server is suspended")

// SetSuspended is the agent's half of architecture doc roadmap M14's two
// independent enforcement points (the panel API is the other). Setting
// suspended=true also force-stops a currently running container — a
// suspended server must not keep serving players a moment longer than
// necessary just because nobody called power/stop first; Kill (not the
// graceful Stop) is used deliberately, since a customer whose payment
// just failed doesn't get a 30-second grace period a normal shutdown
// would. Unsuspending only clears the flag: it does NOT auto-start the
// server, matching this package's existing precedent (Import doesn't
// auto-start a transferred server either) — "usable again" is not the
// same promise as "already running."
func (s *Server) SetSuspended(ctx context.Context, dc dockerFull, suspended bool) error {
	s.mu.Lock()
	s.spec.IsSuspended = suspended
	running := s.State == StateRunning || s.State == StateStarting
	s.mu.Unlock()

	if suspended && running {
		if err := s.Kill(ctx, dc); err != nil {
			return err
		}
	}
	return nil
}

// Suspended reports the server's current suspension flag — used by the
// WS handler to refuse a new console connection outright while
// suspended (architecture doc 2.5's gating table: suspension blocks
// control.* including the console).
func (s *Server) Suspended() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.spec.IsSuspended
}
