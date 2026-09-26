package stats

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

// endlessSource serves the given frames and then blocks, like Docker's stats
// stream for a container that has exited but was not removed.
type endlessSource struct{ frames string }

func (s endlessSource) StatsStream(ctx context.Context, _ string) (io.ReadCloser, error) {
	pr, pw := io.Pipe()
	go func() {
		_, _ = io.Copy(pw, strings.NewReader(s.frames))
		<-ctx.Done()
		_ = pw.Close()
	}()
	return pr, nil
}

const liveFrame = `{"read":"2026-09-26T23:31:20Z","cpu_stats":{},"precpu_stats":{},"memory_stats":{}}` + "\n"
const zeroFrame = `{"read":"0001-01-01T00:00:00Z","cpu_stats":{},"precpu_stats":{},"memory_stats":{}}` + "\n"

func runWithTimeout(t *testing.T, frames string) bool {
	t.Helper()
	c := NewCollector(endlessSource{frames: frames}, "c", 0, 0, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { _ = c.Run(ctx); close(done) }()
	select {
	case <-done:
		return ctx.Err() == nil
	case <-time.After(3 * time.Second):
		t.Fatal("collector never returned")
		return false
	}
}

func TestRunEndsWhenDockerSendsZeroReadFramesForAnExitedContainer(t *testing.T) {
	if !runWithTimeout(t, liveFrame+liveFrame+zeroFrame+zeroFrame) {
		t.Fatal("expected Run to return on its own after consecutive zero-read frames")
	}
}

func TestRunIgnoresASingleZeroReadFrame(t *testing.T) {
	if runWithTimeout(t, liveFrame+zeroFrame+liveFrame) {
		t.Fatal("a single zero-read frame must not end the stream")
	}
}
