package spec

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var envKeyRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

// deniedEnvKeys are never accepted from a template/panel, regardless of
// what the template declares. Most of these are dynamic-linker or
// interpreter hooks that turn "customer sets a variable" into "customer
// runs arbitrary code as the container user" (architecture doc 4.3).
// LD_PRELOAD is the canonical example.
var deniedEnvKeys = map[string]bool{
	"PATH": true, "LD_PRELOAD": true, "LD_LIBRARY_PATH": true, "LD_AUDIT": true,
	"HOME": true, "USER": true, "SHELL": true, "BASH_ENV": true, "ENV": true,
	"IFS": true, "NODE_OPTIONS": true, "PYTHONPATH": true, "PYTHONSTARTUP": true,
	"JAVA_TOOL_OPTIONS": true, "_JAVA_OPTIONS": true, "JDK_JAVA_OPTIONS": true,
	"PERL5OPT": true, "RUBYOPT": true, "GCONV_PATH": true, "TMPDIR": true,
	"LD_ASSUME_KERNEL": true, "LD_ORIGIN_PATH": true,
}

const (
	maxEnvValueBytes = 4096
	maxEnvTotalBytes = 64 * 1024
)

// BuildEnv validates and merges a template's declared variables with
// agent-injected ones into a final Docker `KEY=VALUE` env slice.
//
// declared is the allowlist: only keys the template author explicitly
// declared may come from vars (customer/panel-supplied values). Any key in
// vars that is not in declared is silently dropped and reported, never
// passed through — the allowlist is the template's variable list, not a
// denylist of "bad" keys.
func BuildEnv(declared []string, vars map[string]string, injected map[string]string) (env []string, dropped []string, err error) {
	allowed := make(map[string]bool, len(declared))
	for _, d := range declared {
		allowed[d] = true
	}

	merged := make(map[string]string, len(vars)+len(injected))
	total := 0

	for k, v := range vars {
		if !allowed[k] {
			dropped = append(dropped, k)
			continue
		}
		// The denylist (LD_PRELOAD, HOME, PATH, ...) applies only to
		// customer/template-supplied values: those keys are either
		// dangerous in any hands, or are ones only the agent itself may
		// set (HOME, USER below) via the injected map, which is trusted
		// and validated separately.
		if err := validateEnvKV(k, v, true); err != nil {
			return nil, nil, err
		}
		merged[k] = v
		total += len(k) + len(v) + 1
	}

	// Agent-injected values always win over a customer-supplied value of
	// the same name (SERVER_UUID, HOME, etc. are not customer-controllable).
	for k, v := range injected {
		if err := validateEnvKV(k, v, false); err != nil {
			return nil, nil, fmt.Errorf("spec: internal error building injected env: %w", err)
		}
		if _, existed := merged[k]; existed {
			total -= len(k) + len(merged[k]) + 1
		}
		merged[k] = v
		total += len(k) + len(v) + 1
	}

	if total > maxEnvTotalBytes {
		return nil, nil, fmt.Errorf("spec: total environment size %d bytes exceeds cap of %d", total, maxEnvTotalBytes)
	}

	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic output — required for the spec builder to be a pure function
	env = make([]string, 0, len(keys))
	for _, k := range keys {
		env = append(env, k+"="+merged[k])
	}
	sort.Strings(dropped)
	return env, dropped, nil
}

func validateEnvKV(key, value string, enforceDenylist bool) error {
	if enforceDenylist && deniedEnvKeys[key] {
		return fmt.Errorf("spec: environment key %q is never permitted from a template/customer value", key)
	}
	if !envKeyRe.MatchString(key) {
		return fmt.Errorf("spec: environment key %q does not match ^[A-Z][A-Z0-9_]{0,63}$", key)
	}
	if strings.IndexByte(value, 0) != -1 {
		return fmt.Errorf("spec: environment value for %q contains a NUL byte", key)
	}
	if strings.ContainsAny(value, "\n\r") {
		return fmt.Errorf("spec: environment value for %q contains a newline", key)
	}
	if len(value) > maxEnvValueBytes {
		return fmt.Errorf("spec: environment value for %q exceeds %d bytes", key, maxEnvValueBytes)
	}
	return nil
}
