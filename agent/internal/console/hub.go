package console

import "sync"

const subscriberBufferSize = 256

// Subscriber is one WS connection's inbound channel of console lines. The
// hub NEVER blocks writing to it — see Hub.Publish.
type Subscriber struct {
	ch      chan Line
	dropped uint64
	mu      sync.Mutex
}

func newSubscriber() *Subscriber {
	return &Subscriber{ch: make(chan Line, subscriberBufferSize)}
}

func (s *Subscriber) C() <-chan Line { return s.ch }

// TakeDropped returns and resets the count of lines dropped for this
// subscriber since the last call, so the caller can emit a single
// "console:truncated" notice instead of one per dropped line.
func (s *Subscriber) TakeDropped() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.dropped
	s.dropped = 0
	return n
}

// Hub fans a server's console output out to any number of live
// subscribers. A slow or stalled subscriber degrades its own view (dropped
// frames, reported via TakeDropped) and never blocks the pump, the ring,
// or any other subscriber — this is the backpressure policy from
// architecture doc 4.5, and it is what keeps one bad browser tab from
// stalling everyone else's console.
type Hub struct {
	mu   sync.RWMutex
	subs map[*Subscriber]struct{}
	ring *Ring
}

func NewHub(ring *Ring) *Hub {
	return &Hub{subs: make(map[*Subscriber]struct{}), ring: ring}
}

func (h *Hub) Subscribe() *Subscriber {
	s := newSubscriber()
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

func (h *Hub) Unsubscribe(s *Subscriber) {
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

// Publish appends to the ring and fans the line out to every current
// subscriber via a non-blocking send.
func (h *Hub) Publish(stream, data string) Line {
	line := h.ring.Append(stream, data)

	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs {
		select {
		case s.ch <- line:
		default:
			s.mu.Lock()
			s.dropped++
			s.mu.Unlock()
		}
	}
	return line
}

// RingSince exposes the underlying ring's replay window (see Ring.Since) so
// a newly connected WS client can be backfilled with recent output without
// the caller needing direct access to the Ring itself.
func (h *Hub) RingSince(since uint64) (lines []Line, gap bool) {
	return h.ring.Since(since)
}

func (h *Hub) SubscriberCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs)
}
