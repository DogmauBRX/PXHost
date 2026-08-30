// Package spec builds Docker container specifications from a server's
// configuration. Every exported build function in this package is pure:
// no I/O, no Docker calls, no global state. That is deliberate — it is what
// lets the platform's core isolation invariants (no host access, no
// privilege escalation, no cross-customer reach) be asserted by fast unit
// tests instead of a slow, flaky, Docker-backed integration suite.
package spec

// Server is the subset of a server's configuration the spec builder needs.
// It is intentionally decoupled from any Panel/API wire type so this
// package has zero dependency on the rest of the agent.
type Server struct {
	UUID string // server UUID, used for labels and volume paths
	// UID is the unique host uid:gid this server's container runs as.
	// Allocated by the panel from the node's configured uid range; the
	// agent validates it falls inside that range before use.
	UID int

	Image       string // must be registry-allowlisted and, by policy, digest-pinned
	StartupTmpl string // e.g. "java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui"
	StopSignal  string // e.g. "SIGTERM"; empty defaults to SIGTERM
	Env         map[string]string

	Limits      Limits
	Allocations []Allocation
	Mounts      []MountRequest // admin-defined extra mounts; validated against the node allowlist

	// IsSuspended (architecture doc roadmap M14/2.5) is the SECOND of two
	// independent suspension enforcement points — the panel API also
	// gates every mutating client route, but this field is what makes
	// suspension hold even if the panel is compromised or lagging:
	// srv.Server.Start refuses outright when this is true, regardless of
	// what any caller asks for.
	IsSuspended bool
}

// Limits mirrors the plan's resource fields (architecture doc 2.6 / 4.3).
type Limits struct {
	CPUPercent int   // 100 = one core; 0 = unlimited
	MemoryMB   int64 // hard memory limit
	SwapMB     int64 // 0 = swap disabled (MemorySwap == Memory); -1 = unlimited
	DiskMB     int64 // enforced by the agent's fsx quota accountant, not Docker
	IOWeight   int   // 10..1000, BlkioWeight
	PidsLimit  int64 // default 512 if zero
}

// Allocation is one (ip, port) pair assigned to the server. Primary is
// published as-is: PXHost always maps host port == container port because
// game protocols embed the port in server-list/query responses.
type Allocation struct {
	IP        string
	Port      int
	Primary   bool
	Protocols []string // "tcp", "udp"; defaults to both if empty
}

// MountRequest is a single additional mount the panel is asking for. It is
// only ever honored if it matches an entry in the node-local MountAllowlist
// — the panel's request is never trusted on its own (architecture doc 4.3).
type MountRequest struct {
	Source   string // resolved host path
	Target   string // in-container path, must be under /home/container
	ReadOnly bool
}

// MountAllowlistEntry is node-local configuration (never panel-supplied)
// describing a mount admins have pre-approved on this node.
type MountAllowlistEntry struct {
	Source           string
	ReadOnlyRequired bool
	Targets          []string // exact allowed target paths
}

// Node carries the node-local configuration the spec builder needs: paths,
// network name, uid range, and security profile locations. This is
// deliberately not the full agent config — only what building a spec touches.
type Node struct {
	DataDir      string // e.g. /var/lib/pxhost/servers — <DataDir>/<uuid> is bind-mounted
	InstallDir   string // e.g. /var/lib/pxhost/install — <InstallDir>/<uuid>/install.sh is bind-mounted read-only for the install container
	BackupDir    string // e.g. /var/lib/pxhost/backups — <BackupDir>/<uuid>/*.tar.gz; deliberately OUTSIDE DataDir so a compromised container can never delete or inflate its own backups (architecture doc 4.5)
	TransferDir  string // e.g. /var/lib/pxhost/transfers — node-to-node transfer staging (roadmap M13), same LocalProvider shape as BackupDir but a separate root so a transfer's temp archive never appears in a customer's own backup list
	NetworkName  string // e.g. "pxhost0"
	CgroupParent string // e.g. "pxhost.slice"

	UIDRangeMin int
	UIDRangeMax int

	SeccompProfileJSON string // inline JSON content (already loaded from disk), not a path
	ApparmorProfile    string // empty = do not set (dev/Docker Desktop); set on real Linux nodes

	MountAllowlist []MountAllowlistEntry

	// IOWeightSupported gates whether BlkioWeight is set on containers at
	// all. cgroup v2's io.weight file is only present when the block
	// device's IO scheduler is weight-aware (BFQ) — many NVMe/virtualized
	// backends default to none/mq-deadline and simply lack the file,
	// which makes container start fail outright rather than degrade
	// gracefully. Defaults to false (opt-in) so an untested node's IO
	// scheduler can never turn into a hard failure to start any server;
	// enable it once a node's storage stack is confirmed to support it.
	IOWeightSupported bool

	// LogMaxSize / LogMaxFile bound the container's own log driver so a
	// crash-looping or spammy game server cannot fill the node's disk via
	// stdout (architecture doc 4.3 / threat #15).
	LogMaxSize string // e.g. "8m"
	LogMaxFile string // e.g. "3"
}

const (
	defaultPidsLimit int64 = 512
	defaultNoFile    int64 = 8192
	defaultNProc     int64 = 512
	minHostPort            = 1024 // ports < 1024 need CAP_NET_BIND_SERVICE, which we never grant
	maxHostPort            = 65535
)
