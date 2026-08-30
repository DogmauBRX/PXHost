// Package stats collects and normalizes per-container resource usage from
// Docker's long-lived streaming stats endpoint (architecture doc 4.5).
package stats

// Frame is the wire format pushed to WS subscribers and cached for
// non-streaming REST reads. Field names match the shape documented in the
// architecture doc's WebSocket protocol section.
type Frame struct {
	State            string  `json:"state"`
	CPUPercent       float64 `json:"cpu_percent"`
	CPULimitPercent  float64 `json:"cpu_limit_percent"`
	MemoryBytes      uint64  `json:"memory_bytes"`
	MemoryLimitBytes uint64  `json:"memory_limit_bytes"`
	DiskBytes        uint64  `json:"disk_bytes"`
	DiskLimitBytes   uint64  `json:"disk_limit_bytes"`
	NetworkRxBytes   uint64  `json:"network_rx_bytes"`
	NetworkTxBytes   uint64  `json:"network_tx_bytes"`
	UptimeMS         int64   `json:"uptime_ms"`
}
