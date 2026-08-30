// Package console implements the agent's live console: attaching to a
// running container's stdio, demultiplexing stdout/stderr, buffering
// recent output for reconnecting clients, and fanning it out to any number
// of subscribers without letting a slow subscriber stall the pump
// (architecture doc 4.5).
package console

import "sync"

// Line is one console output line, tagged with the stream it came from and
// a monotonic per-server sequence number so a reconnecting client can
// detect gaps via ?since=<seq>.
type Line struct {
	Seq    uint64 `json:"seq"`
	Stream string `json:"stream"` // "stdout" | "stderr" | "install"
	Data   string `json:"line"`
}

const (
	defaultRingLines = 500
	defaultRingBytes = 256 * 1024
)

// Ring is a fixed-capacity, byte- and line-bounded buffer of recent
// console output for one server. It survives disconnects and container
// crashes (the pump keeps writing to it whether or not anyone is
// subscribed), so a reconnecting client always sees what happened while
// it was away.
type Ring struct {
	mu        sync.Mutex
	lines     []Line
	byteTotal int
	nextSeq   uint64
	maxLines  int
	maxBytes  int
}

func NewRing() *Ring {
	return &Ring{maxLines: defaultRingLines, maxBytes: defaultRingBytes}
}

// Append adds a line, assigning it the next sequence number, and evicts
// the oldest lines once either the line-count or byte cap is exceeded.
func (r *Ring) Append(stream, data string) Line {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.nextSeq++
	l := Line{Seq: r.nextSeq, Stream: stream, Data: data}
	r.lines = append(r.lines, l)
	r.byteTotal += len(data)

	for (len(r.lines) > r.maxLines || r.byteTotal > r.maxBytes) && len(r.lines) > 0 {
		r.byteTotal -= len(r.lines[0].Data)
		r.lines = r.lines[1:]
	}
	return l
}

// Since returns every retained line with Seq > since, plus a bool
// reporting whether older lines were already evicted (a "gap") so the
// caller can tell the client explicitly rather than silently under-replaying.
func (r *Ring) Since(since uint64) (lines []Line, gap bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.lines) == 0 {
		return nil, since > 0 && since < r.nextSeq
	}
	oldest := r.lines[0].Seq
	gap = since > 0 && since < oldest-1
	if since == 0 {
		gap = false // a fresh connect (no since) is a full replay, never a "gap"
	}

	out := make([]Line, 0, len(r.lines))
	for _, l := range r.lines {
		if l.Seq > since {
			out = append(out, l)
		}
	}
	return out, gap
}

func (r *Ring) LastSeq() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.nextSeq
}
