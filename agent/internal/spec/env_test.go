package spec

import (
	"strings"
	"testing"
)

func TestBuildEnv_OnlyDeclaredKeysPassThrough(t *testing.T) {
	env, dropped, err := BuildEnv(
		[]string{"SERVER_JARFILE"},
		map[string]string{"SERVER_JARFILE": "server.jar", "NOT_DECLARED": "x"},
		nil,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(dropped) != 1 || dropped[0] != "NOT_DECLARED" {
		t.Fatalf("expected NOT_DECLARED to be dropped and reported, got dropped=%v", dropped)
	}
	if !containsEnv(env, "SERVER_JARFILE=server.jar") {
		t.Fatalf("expected SERVER_JARFILE to pass through, got %v", env)
	}
}

func TestBuildEnv_DeniedKeysAlwaysRejectedEvenIfDeclared(t *testing.T) {
	for _, key := range []string{"LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "IFS", "PATH", "JAVA_TOOL_OPTIONS"} {
		_, _, err := BuildEnv([]string{key}, map[string]string{key: "anything"}, nil)
		if err == nil {
			t.Fatalf("expected %q to be rejected even when declared by the template", key)
		}
	}
}

func TestBuildEnv_InjectedAlwaysWinsOverCustomerValue(t *testing.T) {
	env, _, err := BuildEnv(
		[]string{"SERVER_UUID"},
		map[string]string{"SERVER_UUID": "customer-supplied-forgery"},
		map[string]string{"SERVER_UUID": "real-uuid"},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !containsEnv(env, "SERVER_UUID=real-uuid") {
		t.Fatalf("expected injected value to win, got %v", env)
	}
	if containsEnv(env, "SERVER_UUID=customer-supplied-forgery") {
		t.Fatalf("customer-supplied value must not survive alongside an injected key, got %v", env)
	}
}

func TestBuildEnv_RejectsInvalidKeyShapes(t *testing.T) {
	bad := []string{"lowercase", "1STARTS_WITH_DIGIT", "HAS-DASH", "HAS SPACE", ""}
	for _, key := range bad {
		_, _, err := BuildEnv([]string{key}, map[string]string{key: "x"}, nil)
		if err == nil {
			t.Fatalf("expected key %q to be rejected", key)
		}
	}
}

func TestBuildEnv_RejectsNewlineAndNulInValues(t *testing.T) {
	cases := map[string]string{
		"HAS_NEWLINE": "a\nb",
		"HAS_CR":      "a\rb",
		"HAS_NUL":     "a\x00b",
	}
	for key, val := range cases {
		_, _, err := BuildEnv([]string{key}, map[string]string{key: val}, nil)
		if err == nil {
			t.Fatalf("expected value for %q to be rejected", key)
		}
	}
}

func TestBuildEnv_ValueLengthCap(t *testing.T) {
	tooLong := strings.Repeat("a", maxEnvValueBytes+1)
	_, _, err := BuildEnv([]string{"BIG"}, map[string]string{"BIG": tooLong}, nil)
	if err == nil {
		t.Fatal("expected an oversized value to be rejected")
	}
}

func TestBuildEnv_DeterministicOutputOrder(t *testing.T) {
	vars := map[string]string{"ZKEY": "1", "AKEY": "2", "MKEY": "3"}
	declared := []string{"ZKEY", "AKEY", "MKEY"}
	env1, _, _ := BuildEnv(declared, vars, nil)
	env2, _, _ := BuildEnv(declared, vars, nil)
	if strings.Join(env1, ",") != strings.Join(env2, ",") {
		t.Fatalf("BuildEnv must be deterministic: %v vs %v", env1, env2)
	}
	if env1[0] != "AKEY=2" {
		t.Fatalf("expected sorted output starting with AKEY, got %v", env1)
	}
}

func containsEnv(env []string, kv string) bool {
	for _, e := range env {
		if e == kv {
			return true
		}
	}
	return false
}
