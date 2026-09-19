package srv

import (
	"context"
	"time"
)

// streamEndOutcome is what the end of a stats stream MEANS for the state
// machine — see classifyStreamEnd.
type streamEndOutcome int

const (
	// outcomeIgnore: the stream ending was expected (a deliberate stop/
	// kill/remove already moved the state, the agent itself is shutting
	// down) or unexplained (the container is still running, so the stream
	// dropped for some other reason). Never guess a crash from a blip.
	outcomeIgnore streamEndOutcome = iota
	// outcomeExited: the container is gone and exited cleanly (code 0) —
	// an in-game `/stop`, or the process finishing on its own. Not a
	// failure, but definitely not "running" either.
	outcomeExited
	// outcomeCrashed: the container is gone with a non-zero exit code.
	outcomeCrashed
)

// classifyStreamEnd decides what a stats stream ending means, given the
// state the server thinks it's in and what Docker says about the
// container. Split out from handleStatsStreamEnded's Docker call so the
// decision itself is unit-testable without a real daemon — dockerx.Client
// is a concrete wrapper with no fake-able seam (see this package's other
// _test.go files for the same reasoning).
//
// `inspectOK` is false when the container could not be inspected at all
// (already removed, daemon unreachable, context cancelled). That is
// deliberately NOT treated as a crash: a delete racing this check would
// otherwise flip a server that no longer exists into "crashed".
func classifyStreamEnd(state State, agentStopping, inspectOK, containerRunning bool, exitCode int) streamEndOutcome {
	if agentStopping {
		return outcomeIgnore
	}
	// Anything other than "running" means some deliberate transition
	// (Stop/Kill/Remove/UpdateVariables) already owns this server's state
	// and tore the collector down on purpose.
	if state != StateRunning {
		return outcomeIgnore
	}
	if !inspectOK || containerRunning {
		return outcomeIgnore
	}
	if exitCode == 0 {
		return outcomeExited
	}
	return outcomeCrashed
}

// handleStatsStreamEnded runs when a running server's stats stream ends.
// Docker keeps that stream open for exactly as long as the container
// lives, so the stream ending on its own — with nobody having asked for a
// stop — is the agent's only signal today that a container died by
// itself.
//
// Found live: a Paper install that downloaded a corrupt jar left the JVM
// exiting immediately with "Invalid or corrupt jarfile", yet the panel's
// console kept showing the server as RUNNING with an uptime counter
// ticking up and gauges frozen at 0%. Nothing ever moved State off
// StateRunning: Start() sets it optimistically right after the Docker
// start call (the real Docker event listener is a later milestone,
// architecture doc 4.1), and the only other writers are the explicit
// power actions. This closes that gap for the case that actually matters
// — the container is gone and nobody asked for it — without the full
// event-stream listener.
func (s *Server) handleStatsStreamEnded(dc dockerFull) {
	s.mu.Lock()
	state := s.State
	containerID := s.ContainerID
	s.mu.Unlock()

	// Cheap pre-checks before paying for a Docker round trip — the common
	// case by far is a deliberate stop, which is never a crash.
	if state != StateRunning || s.bgCtx.Err() != nil || containerID == "" {
		return
	}

	ctx, cancel := context.WithTimeout(s.bgCtx, 10*time.Second)
	defer cancel()
	insp, err := dc.InspectContainer(ctx, containerID)
	inspectOK := err == nil
	running := false
	exitCode := 0
	if inspectOK && insp.State != nil {
		running = insp.State.Running
		exitCode = insp.State.ExitCode
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	// Re-read under the lock: a stop/kill could have landed while the
	// inspect above was in flight.
	switch classifyStreamEnd(s.State, s.bgCtx.Err() != nil, inspectOK, running, exitCode) {
	case outcomeExited:
		s.State = StateOffline
		s.teardownRuntimeLocked()
	case outcomeCrashed:
		s.State = StateCrashed
		s.teardownRuntimeLocked()
	case outcomeIgnore:
	}
}
