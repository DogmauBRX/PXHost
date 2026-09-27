package console

import (
	"bufio"
	"context"
	"errors"
	"io"
	"strings"

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

// pumpLines publishes r line by line until it ends. A line longer than
// maxLineBytes is published as consecutive maxLineBytes chunks — reading
// must never stop early. It used to (bufio.Scanner returns ErrTooLong and
// quits), and nothing restarted it: found live 2026-09-27 on a 318-mod
// Forge pack. One oversized line froze the whole console — both streams
// share StdCopy's demultiplexer, which blocks once either pipe stops being
// read — so the Agent never saw the boot-done or boot-failure line, and the
// game process itself hung blocked on a stdout write nobody would ever
// read, which is what made its crash look like a silent, CPU-idle hang.
func pumpLines(r io.Reader, stream string, hub *Hub) {
	br := bufio.NewReaderSize(r, maxLineBytes)
	for {
		line, err := br.ReadSlice('\n')
		if len(line) > 0 {
			hub.Publish(stream, strings.TrimRight(string(line), "\r\n"))
		}
		if err != nil && !errors.Is(err, bufio.ErrBufferFull) {
			return // io.EOF (container stream ended) or a real read error
		}
	}
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
