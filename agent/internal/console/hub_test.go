package console

import "testing"

func TestHub_PublishFansOutToAllSubscribers(t *testing.T) {
	h := NewHub(NewRing())
	s1 := h.Subscribe()
	s2 := h.Subscribe()

	h.Publish("stdout", "hello")

	for _, s := range []*Subscriber{s1, s2} {
		select {
		case l := <-s.C():
			if l.Data != "hello" {
				t.Fatalf("expected 'hello', got %q", l.Data)
			}
		default:
			t.Fatal("expected a buffered line for every subscriber")
		}
	}
}

func TestHub_SlowSubscriberDropsInsteadOfBlockingPublish(t *testing.T) {
	h := NewHub(NewRing())
	slow := h.Subscribe()

	// Fill the slow subscriber's buffer without ever draining it.
	for i := 0; i < subscriberBufferSize+50; i++ {
		h.Publish("stdout", "line")
	}
	// The critical assertion: Publish must never have blocked. If we got
	// here at all (test didn't hang/timeout), backpressure worked. Confirm
	// drops were actually counted rather than silently lost bookkeeping.
	if slow.TakeDropped() == 0 {
		t.Fatal("expected some lines to be recorded as dropped once the subscriber buffer filled")
	}
}

func TestHub_UnsubscribeStopsFutureDelivery(t *testing.T) {
	h := NewHub(NewRing())
	s := h.Subscribe()
	h.Unsubscribe(s)

	h.Publish("stdout", "after unsubscribe")

	select {
	case l := <-s.C():
		t.Fatalf("expected no delivery after unsubscribe, got %+v", l)
	default:
	}
	if h.SubscriberCount() != 0 {
		t.Fatalf("expected 0 subscribers after unsubscribe, got %d", h.SubscriberCount())
	}
}

func TestHub_PublishAlwaysAppendsToRingRegardlessOfSubscribers(t *testing.T) {
	ring := NewRing()
	h := NewHub(ring)
	h.Publish("stdout", "no one is listening")

	lines, _ := ring.Since(0)
	if len(lines) != 1 || lines[0].Data != "no one is listening" {
		t.Fatalf("expected the ring to retain output even with zero subscribers, got %+v", lines)
	}
}
