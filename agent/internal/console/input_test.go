package console

import (
	"strings"
	"testing"
	"time"
)

func TestRateLimiter_AllowsBurstThenThrottles(t *testing.T) {
	now := time.Now()
	l := NewRateLimiter()
	l.now = func() time.Time { return now }

	for i := 0; i < inputBurst; i++ {
		if !l.Allow() {
			t.Fatalf("expected burst token %d/%d to be allowed", i+1, inputBurst)
		}
	}
	if l.Allow() {
		t.Fatal("expected the bucket to be exhausted after consuming the full burst")
	}
}

func TestRateLimiter_RefillsOverTime(t *testing.T) {
	now := time.Now()
	l := NewRateLimiter()
	l.now = func() time.Time { return now }
	for i := 0; i < inputBurst; i++ {
		l.Allow()
	}
	if l.Allow() {
		t.Fatal("expected exhaustion before advancing the clock")
	}

	now = now.Add(1 * time.Second) // refills inputLinesPerSec tokens
	if !l.Allow() {
		t.Fatal("expected a token to be available after refilling for 1 second")
	}
}

func TestSanitizeInputLine_RejectsOversized(t *testing.T) {
	_, err := SanitizeInputLine(strings.Repeat("a", maxInputLineBytes+1))
	if err == nil {
		t.Fatal("expected an oversized line to be rejected")
	}
}

func TestSanitizeInputLine_RejectsNulAndNewline(t *testing.T) {
	for _, bad := range []string{"a\x00b", "a\nb", "a\rb"} {
		if _, err := SanitizeInputLine(bad); err == nil {
			t.Fatalf("expected %q to be rejected", bad)
		}
	}
}

func TestSanitizeInputLine_PassesThroughOrdinaryCommand(t *testing.T) {
	out, err := SanitizeInputLine("say hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != "say hello world" {
		t.Fatalf("expected the line to pass through unchanged, got %q", out)
	}
}
