package fsx

import "fmt"

// ErrQuotaExceeded is returned by CheckQuota when a write would push the
// server over its plan's disk limit. spec.Limits.DiskMB is enforced HERE,
// not by Docker (there is no filesystem-level quota on a plain bind
// mount) — see the comment on that field in internal/spec/types.go.
var ErrQuotaExceeded = fmt.Errorf("fsx: disk quota exceeded")

// DiskUsageBytes walks the entire jail and sums file sizes. Deliberately
// simple (no incremental/cached counter) for M7: correctness over
// micro-optimizing a walk that only needs to run before a write, not on
// every stats tick — a server with an unreasonably large file count is
// its own, separate problem the plan's file-count limits (later
// milestone) would address.
func (j *Jail) DiskUsageBytes() (int64, error) {
	return j.walkSize(".")
}

func (j *Jail) walkSize(relPath string) (int64, error) {
	entries, err := j.List(relPath)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, e := range entries {
		childPath := relPath + "/" + e.Name
		if relPath == "." {
			childPath = e.Name
		}
		if e.IsDir {
			sub, err := j.walkSize(childPath)
			if err != nil {
				return 0, err
			}
			total += sub
			continue
		}
		total += e.Size
	}
	return total, nil
}

// CheckQuota errors with ErrQuotaExceeded if the server's current usage
// plus addingBytes would exceed limitMb. limitMb <= 0 means unlimited
// (matches the panel's own "0 = unlimited" convention for plan limits).
func (j *Jail) CheckQuota(addingBytes int64, limitMb int64) error {
	if limitMb <= 0 {
		return nil
	}
	used, err := j.DiskUsageBytes()
	if err != nil {
		return fmt.Errorf("fsx: computing disk usage: %w", err)
	}
	limitBytes := limitMb * 1024 * 1024
	if used+addingBytes > limitBytes {
		return fmt.Errorf("%w: %d + %d > %d bytes", ErrQuotaExceeded, used, addingBytes, limitBytes)
	}
	return nil
}
