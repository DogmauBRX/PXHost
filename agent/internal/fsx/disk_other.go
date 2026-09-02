//go:build !linux

package fsx

import "fmt"

// Windows/Docker Desktop dev-only stub — same reasoning as
// jail_other.go: syscall.Statfs doesn't exist outside Linux, and disk
// telemetry (capacity plan Fase 7) is a live-node concern this dev
// environment never needs to exercise for real. serve.go's heartbeat
// loop treats this error as just another best-effort source that failed
// this tick, never fatal.
func DiskUsage(path string) (totalBytes, freeBytes uint64, err error) {
	return 0, 0, fmt.Errorf("fsx: DiskUsage not supported on this platform")
}
