package console

import "testing"

func TestRing_AppendAssignsMonotonicSeq(t *testing.T) {
	r := NewRing()
	l1 := r.Append("stdout", "one")
	l2 := r.Append("stdout", "two")
	if l2.Seq != l1.Seq+1 {
		t.Fatalf("expected monotonic seq, got %d then %d", l1.Seq, l2.Seq)
	}
}

func TestRing_SinceZeroReplaysEverythingWithoutGap(t *testing.T) {
	r := NewRing()
	r.Append("stdout", "a")
	r.Append("stdout", "b")
	lines, gap := r.Since(0)
	if gap {
		t.Fatal("a fresh connect (since=0) must never report a gap")
	}
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d", len(lines))
	}
}

func TestRing_SinceLastSeqReturnsNothingNoGap(t *testing.T) {
	r := NewRing()
	r.Append("stdout", "a")
	last := r.LastSeq()
	lines, gap := r.Since(last)
	if len(lines) != 0 || gap {
		t.Fatalf("expected no new lines and no gap when since==LastSeq, got lines=%d gap=%v", len(lines), gap)
	}
}

func TestRing_EvictsOldestLineOverLineCap(t *testing.T) {
	r := NewRing()
	r.maxLines = 3
	for i := 0; i < 5; i++ {
		r.Append("stdout", "x")
	}
	lines, _ := r.Since(0)
	if len(lines) != 3 {
		t.Fatalf("expected ring capped at 3 lines, got %d", len(lines))
	}
	if lines[0].Seq != 3 { // seqs 1..5 written, only 3,4,5 retained
		t.Fatalf("expected oldest retained seq=3, got %d", lines[0].Seq)
	}
}

func TestRing_EvictsOverByteCap(t *testing.T) {
	r := NewRing()
	r.maxLines = 1000
	r.maxBytes = 10
	r.Append("stdout", "12345")
	r.Append("stdout", "12345")
	r.Append("stdout", "12345") // total would be 15 bytes > 10, oldest evicted
	lines, _ := r.Since(0)
	total := 0
	for _, l := range lines {
		total += len(l.Data)
	}
	if total > 10 {
		t.Fatalf("expected total retained bytes <= 10, got %d across %d lines", total, len(lines))
	}
}

func TestRing_GapReportedWhenOldLinesWereEvicted(t *testing.T) {
	r := NewRing()
	r.maxLines = 2
	r.Append("stdout", "a") // seq 1, will be evicted
	r.Append("stdout", "b") // seq 2, will be evicted
	r.Append("stdout", "c") // seq 3
	r.Append("stdout", "d") // seq 4

	_, gap := r.Since(1) // caller last saw seq 1, but seq 1 and 2 are both gone
	if !gap {
		t.Fatal("expected a gap to be reported when the requested since predates the retained window")
	}
}
