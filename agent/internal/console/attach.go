package console

import (
	"bufio"
	"context"
	"io"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/pkg/stdcopy"
)

const maxLineBytes = 8192

// Attacher is the subset of dockerx.Client the console pump needs. Kept as
// an interface so the pump is unit-testable without a real Docker daemon.
type Attacher interface {
	AttachIO(ctx context.Context, containerID string) (types.HijackedResponse, error)
}

// Pump owns one running container's stdio for its whole lifetime: it
// demultiplexes stdout/stderr into lines, publishes them to the Hub (which
// both records them in the Ring and fans them out to live subscribers),
// and exposes an Input() writer for sending commands to stdin. It keeps
// running even if every subscriber disconnects, so the ring buffer stays
// warm and crash output is never lost (architecture doc 4.5).
type Pump struct {
	hub  *Hub
	conn types.HijackedResponse

	stdinW io.Writer
	done   chan struct{}
}

// Start attaches to the container and begins pumping output into hub in a
// background goroutine. The returned Pump's Close must be called once the
// container stops to release the underlying connection.
func Start(ctx context.Context, a Attacher, containerID string, hub *Hub) (*Pump, error) {
	conn, err := a.AttachIO(ctx, containerID)
	if err != nil {
		return nil, err
	}
	p := &Pump{hub: hub, conn: conn, stdinW: conn.Conn, done: make(chan struct{})}
	go p.run()
	return p, nil
}

func (p *Pump) run() {
	defer close(p.done)

	outR, outW := io.Pipe()
	errR, errW := io.Pipe()

	go func() {
		defer outW.Close()
		defer errW.Close()
		// stdcopy demultiplexes Docker's framed stream (Tty:false) back into
		// separate stdout/stderr readers. This only works because every
		// container spec.BuildContainerSpec produces has Tty:false — a real
		// TTY would merge the two streams and defeat this entirely.
		_, _ = stdcopy.StdCopy(outW, errW, p.conn.Reader)
	}()

	go pumpLines(outR, "stdout", p.hub)
	pumpLines(errR, "stderr", p.hub) // blocks this goroutine until the stream ends
}

func pumpLines(r io.Reader, stream string, hub *Hub) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 4096), maxLineBytes)
	for sc.Scan() {
		hub.Publish(stream, sc.Text())
	}
	// A line longer than maxLineBytes causes bufio.Scanner to error out
	// (ErrTooLong) rather than silently truncate mid-token; that is
	// intentional here so a runaway single line can't be mistaken for
	// several — the caller sees the pump end and can restart it.
}

// Write sends raw bytes to the container's stdin. Callers must apply their
// own rate limiting/validation before calling this (see input.go) — Write
// itself performs no sanitization because its only destination is the
// container's own stdin, never a host shell or anything log-structured.
func (p *Pump) Write(b []byte) (int, error) {
	return p.stdinW.Write(b)
}

func (p *Pump) Close() error {
	return p.conn.Conn.Close()
}

// Done is closed once the underlying stream ends (container stopped/crashed).
func (p *Pump) Done() <-chan struct{} { return p.done }
