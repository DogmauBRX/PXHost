package console

import (
	"strings"
	"testing"
)

func TestPumpLinesKeepsReadingPastAnOversizedLine(t *testing.T) {
	hub := NewHub(NewRing())
	input := "before\n" + strings.Repeat("x", 3*maxLineBytes+10) + "\n" +
		"[main/ERROR] [minecraft/Main]: Failed to start the minecraft server\n" +
		"last line without newline"

	pumpLines(strings.NewReader(input), "stdout", hub)

	lines, _ := hub.RingSince(0)
	var got []string
	for _, line := range lines {
		got = append(got, line.Data)
	}
	joined := strings.Join(got, "\n")
	for _, want := range []string{"before", "Failed to start the minecraft server", "last line without newline"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("pump stopped early: %q missing from published lines", want)
		}
	}
	for _, line := range got {
		if len(line) > maxLineBytes {
			t.Fatalf("published a %d-byte line, want at most %d", len(line), maxLineBytes)
		}
	}
}

func TestPumpLinesStripsLineEndings(t *testing.T) {
	hub := NewHub(NewRing())
	pumpLines(strings.NewReader("a\r\nb\n"), "stdout", hub)
	lines, _ := hub.RingSince(0)
	if len(lines) != 2 || lines[0].Data != "a" || lines[1].Data != "b" {
		t.Fatalf("got %+v, want [a b]", lines)
	}
}
