package console

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	maxInputLineBytes = 1024
	inputLinesPerSec  = 5
	inputBurst        = 10
)

// RateLimiter is a simple token bucket. One instance guards one WS
// connection's console input, per architecture doc 4.5 — this is what
// stops a compromised or malicious client from flooding a container's
// stdin (or, transitively, the console pump/hub) faster than a human
// could ever legitimately type.
type RateLimiter struct {
	mu         sync.Mutex
	tokens     float64
	maxTokens  float64
	refillRate float64 // tokens per second
	last       time.Time
	now        func() time.Time
}

func NewRateLimiter() *RateLimiter {
	return &RateLimiter{
		tokens:     inputBurst,
		maxTokens:  inputBurst,
		refillRate: inputLinesPerSec,
		last:       time.Now(),
		now:        time.Now,
	}
}

// Allow reports whether one unit of work (one console line) may proceed
// right now, consuming a token if so.
func (l *RateLimiter) Allow() bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	elapsed := now.Sub(l.last).Seconds()
	l.last = now
	// A backward-moving clock (NTP correction, or — as found on real
	// Linux, not Windows, running this package's own tests — two
	// back-to-back time.Now() calls landing in the opposite order the
	// wall clock's resolution would suggest) must never DRAIN the
	// bucket. Negative elapsed is clamped to zero rather than applied.
	if elapsed > 0 {
		l.tokens += elapsed * l.refillRate
	}
	if l.tokens > l.maxTokens {
		l.tokens = l.maxTokens
	}
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}

// SanitizeInputLine validates a single console command before it is ever
// written to a container's stdin. This is deliberately narrow: the only
// destination for this string is stdin, never a shell, never a log line
// formatted with %s into something structured — so the checks here are
// about the console being usable and bounded, not about escaping shell
// metacharacters (there is nothing to escape into).
func SanitizeInputLine(s string) (string, error) {
	if len(s) > maxInputLineBytes {
		return "", fmt.Errorf("console: input line exceeds %d bytes", maxInputLineBytes)
	}
	if strings.IndexByte(s, 0) != -1 {
		return "", fmt.Errorf("console: input line contains a NUL byte")
	}
	// Embedded newlines are rejected rather than split: a legitimate
	// console command is one line, and silently splitting a multi-line
	// paste could let a client route around the rate limiter's
	// per-request accounting.
	if strings.ContainsAny(s, "\n\r") {
		return "", fmt.Errorf("console: input line must not contain a newline")
	}
	return s, nil
}
