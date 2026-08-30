package backup

import (
	"path"
	"strings"
)

// IgnoreSet matches relative paths against glob patterns — node defaults
// + per-request patterns + the server's own .pxignore file (architecture
// doc 4.5), merged by the caller before construction. Deliberately
// simple glob matching (full-path glob, basename glob, or directory-
// prefix match), not full gitignore semantics (negation, anchoring,
// "**") — the requirement this milestone targets is "a backup excludes
// what it's told to exclude," not gitignore parity.
type IgnoreSet struct {
	patterns []string
}

// NewIgnoreSet builds a set from raw pattern lines, dropping blanks and
// "#"-comments (the .pxignore convention).
func NewIgnoreSet(patterns ...string) *IgnoreSet {
	clean := make([]string, 0, len(patterns))
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" || strings.HasPrefix(p, "#") {
			continue
		}
		clean = append(clean, p)
	}
	return &IgnoreSet{patterns: clean}
}

// Match reports whether relPath itself, its basename, or an ancestor
// directory matches an ignore pattern. Safe to call on a nil *IgnoreSet
// (nothing ignored) so callers never need a separate "no ignores" case.
func (s *IgnoreSet) Match(relPath string) bool {
	if s == nil {
		return false
	}
	for _, p := range s.patterns {
		if ok, _ := path.Match(p, relPath); ok {
			return true
		}
		if ok, _ := path.Match(p, path.Base(relPath)); ok {
			return true
		}
		trimmed := strings.TrimSuffix(p, "/")
		if relPath == trimmed || strings.HasPrefix(relPath, trimmed+"/") {
			return true
		}
	}
	return false
}
