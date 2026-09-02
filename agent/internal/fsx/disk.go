//go:build linux

package fsx

import (
	"fmt"
	"syscall"
)

// DiskUsage reports the total and free size, in bytes, of the
// filesystem containing path (capacity plan Fase 7's disk telemetry —
// called with the node's own data_dir). Free uses Bavail (blocks
// available to an UNPRIVILEGED user), never Bfree (blocks free
// including the ~5% reserved for root): that reserve was never vendable
// capacity, and reporting Bfree would overstate what the node actually
// has to sell.
func DiskUsage(path string) (totalBytes, freeBytes uint64, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0, fmt.Errorf("fsx: statfs %q: %w", path, err)
	}
	blockSize := uint64(stat.Bsize)
	return stat.Blocks * blockSize, stat.Bavail * blockSize, nil
}
