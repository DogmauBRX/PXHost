package stats

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
)

// StatsSource is the subset of dockerx.Client the collector needs. Kept as
// an interface so Collector is unit-testable against a canned stream
// without a real Docker daemon.
type StatsSource interface {
	StatsStream(ctx context.Context, containerID string) (io.ReadCloser, error)
}

// Normalize converts one raw Docker StatsResponse into a Frame. It is a
// pure function (given the two raw samples it needs for CPU deltas) so the
// two corrections that matter most are independently testable:
//
//   - CPU percent is computed the same way `docker stats`/the CLI does:
//     delta(container usage) / delta(system usage) * onlineCPUs * 100 —
//     expressed against the HOST, so a container with a 200% quota can
//     legitimately read up to 200.
//   - Memory usage subtracts the page-cache figure (inactive_file on
//     cgroup v2, cache on cgroup v1) from Docker's raw `usage`, or every
//     container falsely appears to sit near its memory limit — this is
//     the single most common bug in naive Docker stats displays
//     (architecture doc 4.5).
func Normalize(cur, prev container.StatsResponse, state string, memLimitBytes, cpuLimitPercent, diskBytes, diskLimitBytes uint64, uptime time.Duration) Frame {
	cpuDelta := float64(cur.CPUStats.CPUUsage.TotalUsage) - float64(prev.CPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(cur.CPUStats.SystemUsage) - float64(prev.CPUStats.SystemUsage)
	onlineCPUs := float64(cur.CPUStats.OnlineCPUs)
	if onlineCPUs == 0 {
		onlineCPUs = float64(len(cur.CPUStats.CPUUsage.PercpuUsage))
	}
	if onlineCPUs == 0 {
		onlineCPUs = 1
	}

	var cpuPercent float64
	if sysDelta > 0 && cpuDelta >= 0 {
		cpuPercent = (cpuDelta / sysDelta) * onlineCPUs * 100.0
	}

	memUsage := cur.MemoryStats.Usage
	cache := cur.MemoryStats.Stats["inactive_file"]
	if cache == 0 {
		cache = cur.MemoryStats.Stats["total_inactive_file"]
	}
	if cache == 0 {
		cache = cur.MemoryStats.Stats["cache"]
	}
	if cache <= memUsage {
		memUsage -= cache
	}

	var rx, tx uint64
	for _, n := range cur.Networks {
		rx += n.RxBytes
		tx += n.TxBytes
	}

	return Frame{
		State:            state,
		CPUPercent:       round2(cpuPercent),
		CPULimitPercent:  float64(cpuLimitPercent),
		MemoryBytes:      memUsage,
		MemoryLimitBytes: memLimitBytes,
		DiskBytes:        diskBytes,
		DiskLimitBytes:   diskLimitBytes,
		NetworkRxBytes:   rx,
		NetworkTxBytes:   tx,
		UptimeMS:         uptime.Milliseconds(),
	}
}

func round2(f float64) float64 {
	return float64(int64(f*100)) / 100
}

// Collector runs one long-lived StatsStream per running container — never
// a per-tick poll, which the architecture doc flags as costing ~10ms of
// daemon time per call and not scaling past roughly 20 containers on a
// node. It decodes each frame, normalizes it, and stores only the latest
// value (Latest) plus notifies subscribers via OnFrame.
type Collector struct {
	src           StatsSource
	containerID   string
	memLimitBytes uint64
	cpuLimit      uint64
	diskBytesFn   func() (used, limit uint64)
	startedAt     time.Time

	mu     sync.RWMutex
	latest Frame

	onFrame func(Frame)
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
}

func NewCollector(src StatsSource, containerID string, memLimitBytes, cpuLimitPercent uint64, diskBytesFn func() (used, limit uint64), onFrame func(Frame)) *Collector {
	ctx, cancel := context.WithCancel(context.Background())
	return &Collector{
		src: src, containerID: containerID,
		memLimitBytes: memLimitBytes, cpuLimit: cpuLimitPercent,
		diskBytesFn: diskBytesFn, onFrame: onFrame,
		startedAt: time.Now(),
		ctx:       ctx, cancel: cancel,
		done: make(chan struct{}),
	}
}

func (c *Collector) Latest() Frame {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.latest
}

// Run blocks decoding frames from the stats stream until ctx is cancelled
// or the stream ends (container stopped). Intended to be run in its own
// goroutine per running container.
func (c *Collector) Run(parent context.Context) error {
	defer close(c.done)
	ctx := c.ctx
	go func() {
		select {
		case <-parent.Done():
			c.cancel()
		case <-ctx.Done():
		}
	}()

	rc, err := c.src.StatsStream(ctx, c.containerID)
	if err != nil {
		return err
	}
	defer rc.Close()

	dec := json.NewDecoder(rc)
	var prev container.StatsResponse
	haveFirst := false

	for {
		var cur container.StatsResponse
		if err := dec.Decode(&cur); err != nil {
			if err == io.EOF || ctx.Err() != nil {
				return nil
			}
			return err
		}
		if !haveFirst {
			prev = cur
			haveFirst = true
			continue // need two samples to compute a CPU delta
		}

		var diskUsed, diskLimit uint64
		if c.diskBytesFn != nil {
			diskUsed, diskLimit = c.diskBytesFn()
		}

		frame := Normalize(cur, prev, "running", c.memLimitBytes, c.cpuLimit, diskUsed, diskLimit, time.Since(c.startedAt))
		prev = cur

		c.mu.Lock()
		c.latest = frame
		c.mu.Unlock()

		if c.onFrame != nil {
			c.onFrame(frame)
		}
	}
}

// Stop cancels the stream and blocks until Run has returned. The caller
// must have already started Run in a goroutine — calling Stop on a
// Collector whose Run was never started blocks forever, by design (it
// mirrors every other pump/goroutine-owning type in this codebase: Stop
// means "wait for the thing I started to actually finish").
func (c *Collector) Stop() {
	c.cancel()
	<-c.done
}
