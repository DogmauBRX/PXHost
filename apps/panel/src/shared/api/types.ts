export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; username: string; globalRole: string };
}

// Client account management, Fase 1 — mirrors GET /api/client/account's
// response (AccountService's ACCOUNT_SELECT + twoFactorEnabled).
export interface ClientAccount {
  id: string;
  email: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  globalRole: string;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  twoFactorEnabled: boolean;
  createdAt: string;
  // Billing profile — collected at checkout time (CheckoutPage.tsx), not
  // signup. All null until the owner subscribes to a plan for the first
  // time. billingCountry is deliberately absent — server-managed, always
  // "BR" today, not client-editable (see the User model's schema comment).
  cpf: string | null;
  billingPostalCode: string | null;
  billingAddressLine: string | null;
  billingAddressNumber: string | null;
  billingAddressComplement: string | null;
  billingNeighborhood: string | null;
  billingCity: string | null;
  billingState: string | null;
}

// Mirrors apps/api/src/modules/templates/software.ts's describeSoftware()
// output — the ONE place "/plugins" vs "/mods" is decided. Never re-derive
// this on the frontend; always read it off the server response.
export type SoftwareKind = 'paper' | 'purpur' | 'spigot' | 'bukkit' | 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'vanilla' | 'bungeecord' | 'velocity' | 'other';

// The 6 software choices the admin "criação rápida" wizard offers as
// cards (Admin Templates redesign) — a strict subset of `SoftwareKind`,
// mirroring `apps/api/src/modules/templates/software-presets.ts`'s own
// `PRESET_KINDS`. Every other kind still exists, just only reachable
// through the advanced/manual template form.
export type PresetKind = 'paper' | 'fabric' | 'quilt' | 'vanilla' | 'forge' | 'neoforge' | 'purpur';

export interface SoftwareInfo {
  kind: SoftwareKind | null;
  label: string;
  addonDir: 'plugins' | 'mods' | null;
  addonDirDisplay: '/plugins' | '/mods' | null;
  addonNoun: 'plugin' | 'mod' | null;
  addonLabel: 'Plugins' | 'Mods' | null;
  isProxy: boolean;
}

// What a customer may see of their plan — advisory recommendations plus
// commercial fields, never the node-tuning columns (cpuPinning,
// blockIoReadBps/WriteBps, allowedGroupIds). All six recommendation
// fields are nullable: null means the plan simply doesn't publish that
// range, render nothing rather than "0–0".
export interface ClientPlan {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  memoryMb: number;
  diskMb: number;
  cpuLimitPercent: number;
  maxBackups: number;
  maxDatabases: number;
  maxSchedules: number;
  backupRetentionDays: number;
  hardwareLabel: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  currency: string;
  billingPeriod: string;
  maxServers: number | null;
  recommendedPlayersMin: number | null;
  recommendedPlayersMax: number | null;
  recommendedModsMin: number | null;
  recommendedModsMax: number | null;
  recommendedPluginsMin: number | null;
  recommendedPluginsMax: number | null;
}

export interface ServerSummary {
  id: string;
  shortId: string;
  name: string;
  status: string;
  powerState: string;
  memoryMb: number;
  diskMb: number;
  cpuLimitPercent: number;
  createdAt: string;
  node: { id: string; name: string };
  plan: ClientPlan | null;
  template: { id: string; name: string } | null;
  allocations: { ip: string; port: number; isPrimary: boolean }[];
  software: SoftwareInfo;
  // Public-exposure plan — set only once a gateway has actually
  // confirmed this route ('active'), never for pending/failed. Null
  // means "not exposed" — the UI falls back to allocations[].ip:port,
  // exactly today's behavior.
  publicAddress: string | null;
  // Custom-hostname plan — the raw label the customer chose (e.g.
  // "survival"), or null. Distinct from publicAddress, which is the
  // fully-composed, display-ready string — this is what pre-fills the
  // Configurações tab's input.
  customHostname: string | null;
  // The installed MINECRAFT_VERSION value, or null when the template
  // never declared that variable (or nothing has resolved it yet).
  minecraftVersion: string | null;
}

export interface ServerDetail extends ServerSummary {
  node: { id: string; name: string; fqdn: string; scheme: string; daemonPort: number };
  role: 'owner' | 'subuser' | 'admin';
  /** Every permission key this caller actually holds — lets the UI hide an action instead of showing a button that 403s. Affordance only; the backend still enforces it. */
  permissions: string[];
}

// GET /api/client/servers/:id/setup — the post-purchase setup screen's
// only data source. `software` is deliberately narrow: never the
// technical fields a template also carries (dockerImages, installScript,
// SERVER_JARFILE/PAPER_BUILD/etc.) — those stay server-side, resolved by
// `POST .../setup` from the chosen `id` + `version` alone. `versions`
// comes from the template's own MINECRAFT_VERSION variable's `in:` rule
// when curated (`versionsCurated: true`); otherwise it's a single-entry
// array holding the variable's default (e.g. "latest"), signaling the
// UI to render a free-text hint instead of a fixed dropdown.
export interface ServerSetupSoftwareOption {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  softwareKind: SoftwareKind | null;
  group: { id: string; name: string; iconUrl: string | null };
  versions: string[];
  defaultVersion: string | null;
  versionsCurated: boolean;
}

export interface ServerSetupInfo {
  status: string;
  name: string;
  plan: { memoryMb: number; diskMb: number; cpuLimitPercent: number };
  software: ServerSetupSoftwareOption[];
}

// Deliberately no disk fields — the agent's disk_bytes/disk_limit_bytes
// are always 0 (see apps/api's AgentStatsFrame doc comment), so this type
// simply doesn't carry them rather than tempting a UI to render a fake 0%.
export interface ServerStatsSnapshot {
  online: boolean;
  state: string | null;
  cpuPercent: number | null;
  cpuLimitPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  uptimeMs: number | null;
  measuredAt: string;
}

// Mirrors apps/api/src/modules/assistant/assistant.types.ts field-for-field
// — a closed route enum (never a raw URL) and a typed block union (never
// markdown), so links.tsx maps every AssistantRoute to a real typed
// router <Link> and AssistantBlocks never touches dangerouslySetInnerHTML.
export type AssistantRoute =
  | 'server.console'
  | 'server.files'
  | 'server.addons'
  | 'server.backups'
  | 'server.variables'
  | 'server.databases'
  | 'server.schedules'
  | 'server.subusers'
  | 'server.activity'
  | 'client.plan'
  | 'client.support';

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'steps'; items: string[] }
  | { type: 'code'; language?: string; code: string }
  | { type: 'note'; tone: 'info' | 'warn'; text: string }
  | { type: 'link'; route: AssistantRoute; label: string }
  | { type: 'external'; url: string; label: string }
  | { type: 'kv'; items: { label: string; value: string }[] };

export interface AssistantMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantReply {
  blocks: AssistantBlock[];
  topicId?: string;
  confident: boolean;
}

export interface AssistantSuggestion {
  topicId: string;
  title: string;
}

export interface ConsoleTokenResponse {
  token: string;
  expiresIn: number;
  wsUrl: string;
}

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mode: string;
  modTime: string;
}

export interface TransferLink {
  url: string;
  expiresIn: number;
  maxBytes?: number;
}

export interface BackupSummary {
  id: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface DatabaseSummary {
  id: string;
  database: string;
  username: string;
  remote: string;
  createdAt: string;
  host: { id: string; name: string; host: string; port: number };
}

export interface CreatedDatabase extends DatabaseSummary {
  password: string;
}

export type TaskAction = 'power' | 'backup';

export interface ScheduleTask {
  id: string;
  sequenceNumber: number;
  action: TaskAction;
  payload: string;
  timeOffsetSeconds: number;
  continueOnFailure: boolean;
}

export interface Schedule {
  id: string;
  name: string;
  cronMinute: string;
  cronHour: string;
  cronDayOfMonth: string;
  cronMonth: string;
  cronDayOfWeek: string;
  timezone: string;
  isActive: boolean;
  onlyWhenOnline: boolean;
  isProcessing: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextRunAt: string;
  tasks: ScheduleTask[];
}

export interface PermissionCatalogEntry {
  key: string;
  scope: string;
  groupKey: string;
  i18nKey: string;
  isDangerous: boolean;
  sortOrder: number;
}

export interface Subuser {
  id: string;
  permissions: string[];
  acceptedAt: string | null;
  createdAt: string;
  user: { id: string; username: string; email: string };
}

export interface ActivityEntry {
  id: string;
  event: string;
  properties: Record<string, unknown>;
  createdAt: string;
  actor: { id: string; username: string; email: string } | null;
}

export interface Location {
  id: string;
  shortCode: string;
  name: string;
  country: string | null;
  createdAt: string;
}

export interface AdminNode {
  id: string;
  locationId: string;
  name: string;
  description: string | null;
  fqdn: string;
  scheme: string;
  daemonPort: number;
  // Deploy plan — the panel↔agent control-plane origin, when it differs
  // from fqdn/scheme/daemonPort (which stay the browser's own direct
  // console/file/backup target, unchanged). Null = same as the browser
  // uses, the default for every node. Set this to a node's private
  // WireGuard address to keep the control plane off the public internet.
  controlAddress: string | null;
  // Public-exposure plan — this node's own address on the WireGuard
  // tunnel (e.g. "10.10.0.2"), as structured data the gateway
  // reconciler reads directly. Null = this node is not reachable from
  // any gateway yet; its servers simply never get a public route.
  tunnelIp: string | null;
  // Placement policy — reserves this node for plans priced at or above
  // this amount (cents). Null = no reservation. Set once, applies
  // automatically to any pricier plan added later — see the API's own
  // Node.reservedForPlansAbovePriceCents schema comment.
  reservedForPlansAbovePriceCents: number | null;
  daemonDataPath: string;
  memoryTotalMb: number;
  memoryReservedMb: number;
  memoryOverallocatePct: number;
  diskTotalMb: number;
  diskReservedMb: number;
  diskOverallocatePct: number;
  cpuTotalPercent: number;
  cpuReservedPercent: number;
  cpuOverallocatePct: number;
  isPublic: boolean;
  maintenanceMode: boolean;
  // A future heads-up, distinct from `maintenanceMode` itself — see
  // that column's own doc comment on the API side (schema.prisma).
  maintenanceScheduledAt: string | null;
  healthStatus: string;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  createdAt: string;
  // Capacity plan (auto-derivation) — 'manual' (every node's default)
  // keeps the declared columns above as the ceiling; 'auto' derives it
  // from reported telemetry instead. Margins/thresholds always apply
  // (thresholds even in manual mode — see capacityStatus).
  capacityMode: 'manual' | 'auto';
  memorySafetyMarginPct: number;
  diskSafetyMarginPct: number;
  cpuSafetyMarginPct: number;
  capacityWarnPct: number;
  capacityHighPct: number;
  capacityCriticalPct: number;
  // Capacity plan Fase 2/7: what the agent ACTUALLY reports, distinct
  // from the declared columns above. Null until an agent new enough to
  // send them heartbeats at least once — never copied into the declared
  // fields directly (only resolveNodeCapacity, in 'auto' mode, reads
  // reportedMemoryLimitMb/reportedMemoryTotalMb/reportedDiskTotalMb/
  // reportedCpuCount as a ceiling).
  reportedMemoryTotalMb: number | null;
  // The node's own cgroup memory limit — preferred over
  // reportedMemoryTotalMb in auto mode (the LXC/Proxmox host-vs-guest
  // RAM fix). Null on an agent older than this milestone, or when the
  // cgroup is genuinely unlimited.
  reportedMemoryLimitMb: number | null;
  reportedCpuCount: number | null;
  reportedDiskTotalMb: number | null;
  reportedDiskFreeMb: number | null;
  reportedOs: string | null;
  reportedKernel: string | null;
  reportedContainersRunning: number | null;
  reportedAt: string | null;
  agentUptimeSeconds: number | null;
  // Hardware-capacity detection: deeper host telemetry than the block
  // above. Purely informational — never enters telemetryDivergence or
  // any capacity math. reportedCpuPhysicalCores/reportedCpuSockets are
  // null whenever the agent detects it's running inside an LXC container
  // (see the agent's internal/hostinfo package) — show "N/A", not 0.
  reportedCpuModel: string | null;
  reportedCpuSockets: number | null;
  reportedCpuPhysicalCores: number | null;
  reportedCpuUsagePercent: number | null;
  reportedLoadAvg1: number | null;
  reportedMemoryUsedMb: number | null;
  reportedMemoryAvailableMb: number | null;
  reportedVirtualizationSystem: string | null;
  reportedVirtualizationRole: string | null;
  // Computed at read time (never stored) — see nodes.service.ts's
  // deriveTelemetryDivergence. 'over' ONLY when declared exceeds
  // reported (the dangerous direction); declaring less is normal.
  telemetryDivergence: { memory: 'ok' | 'over' | 'unknown'; disk: 'ok' | 'over' | 'unknown'; cpu: 'ok' | 'over' | 'unknown' };
}

export interface BootstrapTokenResponse {
  token: string;
  expiresAt: string;
  command: string;
}

// Capacity plan (auto-derivation) — the 4-level alert vocabulary
// (🟢🟡🟠🔴), backed by Meter's own 'high' tone/`--color-high` token.
export type CapacityStatus = 'normal' | 'warning' | 'high' | 'critical';

// A dimension's provenance chain (§25: detected → margin → effective →
// reserved → available) — mirrors the API's `ResolvedDimension`.
// 'manual': `declared` IS `effectiveTotal`, `detected` may still be
// present for display (a manual node can still have telemetry) but was
// never consulted. 'auto': `effectiveTotal` comes from `detected`.
// 'unconfigured': auto mode with no telemetry for this dimension yet —
// never a green light for new sales (see `NodeCapacitySnapshot
// .acceptsNewServers`).
export type CapacityProvenance = 'auto' | 'manual' | 'unconfigured';

// Capacity plan Fase 2/3 — shapes returned by /api/admin/capacity/*.
// `ceiling`/`available` are `null` for a genuinely unlimited dimension
// (overallocatePct === -1); `commercial` is always a finite number for
// display (falls back to physical-minus-reserved when unlimited — see
// `commercialIsFloor`/`isUnlimited`, which say whether that number is a
// real ceiling or just a reportable floor).
export interface CapacityDimensionSnapshot {
  totalPhysical: number;
  reservedAmount: number;
  overallocatePct: number;
  ceiling: number | null;
  commercial: number;
  isUnlimited: boolean;
  allocated: number;
  available: number | null;
  usedPct: number;
  status: CapacityStatus;
  // §25's chain, for display — `totalPhysical`/`reservedAmount` above
  // are already the EFFECTIVE (post-margin) values `ceilingFor` used;
  // these three are the raw inputs that produced them.
  provenance: CapacityProvenance;
  detected: number | null;
  safetyMarginPct: number;
}

export interface NodeCapacitySnapshot {
  id: string;
  name: string;
  healthStatus: string;
  maintenanceMode: boolean;
  isPublic: boolean;
  serverCount: number;
  // Capacity plan (auto-derivation)
  capacityMode: 'manual' | 'auto';
  telemetryStale: boolean;
  acceptsNewServers: boolean;
  acceptsNewServersReason: string | null;
  memory: CapacityDimensionSnapshot;
  disk: CapacityDimensionSnapshot;
  cpu: CapacityDimensionSnapshot & { accountingEnabled: boolean };
}

export interface CapacityAggregate {
  physical: number;
  reserved: number;
  commercial: number;
  commercialIsFloor: boolean;
  allocated: number;
  available: number;
}

export interface CapacityDashboard {
  nodes: { total: number; online: number; offline: number; disabled: number };
  servers: { total: number; active: number; suspended: number; offline: number; byStatus: Record<string, number> };
  memory: CapacityAggregate;
  disk: CapacityAggregate;
  cpu: CapacityAggregate;
  perNode: NodeCapacitySnapshot[];
}

// One node's contribution to a plan's derived vagas — `slots: 0` with a
// `reason` (not a fit failure) means the node itself refuses new servers
// right now (maintenance, or auto mode without trustworthy telemetry —
// see `NodeCapacitySnapshot.acceptsNewServers`).
export interface PlanNodeSlots {
  nodeId: string;
  nodeName: string;
  slots: number | null;
  limiting: 'memory' | 'disk' | 'cpu' | null;
  reason: string | null;
}

export interface PlanOccupancy {
  id: string;
  name: string;
  slug: string;
  isPublic: boolean;
  memoryMb: number;
  diskMb: number;
  cpuLimitPercent: number;
  occupied: number;
  // Capacity plan (auto-derivation) §6/§11 — `maxSlots` mirrors
  // `AdminPlan.maxSlots` (the optional commercial ceiling); `derivedSlots`
  // is the sum of real node capacity across every eligible node (`null` =
  // unlimited); `effectiveSlots` is `min(derivedSlots, maxSlots)` and
  // `remaining` is `effectiveSlots - occupied`, floored at 0. `perNode`
  // is the §16 breakdown.
  maxSlots: number | null;
  derivedSlots: number | null;
  effectiveSlots: number | null;
  remaining: number | null;
  perNode: PlanNodeSlots[];
}

// GET /api/admin/capacity/nodes/:id/plans — the same derivation as
// `PlanOccupancy.perNode`, scoped to one node, for every plan.
export interface NodePlanSlots {
  nodeId: string;
  nodeName: string;
  acceptsNewServers: boolean;
  results: { planId: string; planName: string; slots: number | null; limiting: 'memory' | 'disk' | 'cpu' | null; reason: string | null }[];
}

export interface CapacitySimulateResult {
  planId: string;
  planName: string;
  request: { memoryMb: number; diskMb: number; cpuPercent: number };
  results: { nodeId: string; name: string; fits: boolean; reasons: string[]; healthStatus: string }[];
}

export interface Allocation {
  id: string;
  ip: string;
  port: number;
  isPrimary: boolean;
  serverId: string | null;
}

export interface TemplateGroup {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface AdminTemplateVariable {
  id: string;
  name: string;
  description: string | null;
  envVariable: string;
  defaultValue: string | null;
  rules: string | null;
  isUserViewable: boolean;
  isUserEditable: boolean;
  sortOrder: number;
}

export interface AdminTemplate {
  id: string;
  groupId: string;
  name: string;
  author: string;
  description: string | null;
  dockerImages: Record<string, string>;
  startupCommand: string;
  stopCommand: string | null;
  installImage: string | null;
  installEntrypoint: string | null;
  installScript: string;
  softwareKind: SoftwareKind | null;
  isActive: boolean;
  isPublic: boolean;
  sortOrder: number;
  iconUrl: string | null;
  createdAt: string;
  variables: AdminTemplateVariable[];
}

export interface AdminPlan {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isPublic: boolean;
  sortOrder: number;
  cpuLimitPercent: number;
  memoryMb: number;
  swapMb: number;
  diskMb: number;
  ioWeight: number;
  oomKillEnabled: boolean;
  maxDatabases: number;
  maxBackups: number;
  maxAllocations: number;
  maxSchedules: number;
  backupRetentionDays: number;
  hardwareLabel: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  currency: string;
  billingPeriod: string;
  // Checkout redesign (WHMCS-style) — see Plan.planFamily's own doc
  // comment in schema.prisma. null = single-cycle product.
  planFamily: string | null;
  maxServers: number | null;
  // Capacity plan Fase 4 — commercial stock. null = unlimited.
  // Deliberately absent from `ClientPlan` above (remaining stock is a
  // live query, not something this static field alone can render
  // meaningfully to a customer — see the capacity plan's own
  // "Pontos em aberto").
  maxSlots: number | null;
  // Commercial site — admin-picked highlight (never algorithmic), see
  // Plan.isFeatured's own doc comment on the API side.
  isFeatured: boolean;
  highlightLabel: string | null;
  recommendedPlayersMin: number | null;
  recommendedPlayersMax: number | null;
  recommendedModsMin: number | null;
  recommendedModsMax: number | null;
  recommendedPluginsMin: number | null;
  recommendedPluginsMax: number | null;
  createdAt: string;
}

// Capacity plan Fase 4/5 — one row per node this plan is explicitly
// allowed to schedule onto, ordered by `priority` (higher = preferred
// by NodeSchedulerService.selectNode's fitScore). A plan with zero rows
// is unrestricted — see PlansService.listAllowedNodes's own comment.
export interface PlanNodeAssignment {
  planId: string;
  nodeId: string;
  priority: number;
  node: { id: string; name: string };
}

export interface PlanDriftChange {
  field: string;
  from: number | boolean;
  to: number | boolean;
}

export interface PlanDriftEntry {
  serverId: string;
  serverName: string;
  nodeId: string;
  changes: PlanDriftChange[];
}

// Capacity plan Fase 6 — the wall `apply` will hit, shown before the click.
export interface PlanCapacityPreviewEntry {
  nodeId: string;
  nodeName: string;
  fits: boolean;
  reasons: string[];
  affectedServerIds: string[];
}

export interface PlanDriftReport {
  plan: { id: string; name: string };
  affectedCount: number;
  servers: PlanDriftEntry[];
  capacity: PlanCapacityPreviewEntry[];
}

export interface PlanApplyResult {
  appliedCount: number;
  failures: { serverId: string; error: string }[];
}

export interface AdminServerSummary {
  id: string;
  shortId: string;
  name: string;
  status: string;
  node: { id: string; name: string };
  plan: { id: string; name: string } | null;
  owner: { id: string; username: string; email: string } | null;
}

export interface AdminServerDetail {
  id: string;
  shortId: string;
  name: string;
  status: string;
  powerState: string;
  memoryMb: number;
  diskMb: number;
  cpuLimitPercent: number;
  createdAt: string;
  node: { id: string; name: string; fqdn: string };
  plan: AdminPlan | null;
  template: { id: string; name: string; author: string } | null;
  allocations: { ip: string; port: number; isPrimary: boolean }[];
  owner: { id: string; username: string; email: string } | null;
  publicRoute: { publicPort: number; state: string; lastError: string | null; gateway: { id: string; name: string; publicHost: string } } | null;
}

export type SupportTicketStatus = 'open' | 'in_progress' | 'waiting_customer' | 'closed';
export type SupportTicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SupportTicketCategory = 'technical' | 'billing' | 'account' | 'other';

export interface SupportTicketSummary {
  id: string;
  subject: string;
  category: SupportTicketCategory;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  lastMessageAt: string;
  createdAt: string;
  closedAt: string | null;
  server: { id: string; name: string; shortId: string } | null;
  user: { id: string; username: string; email: string };
  messages: { body: string; isStaff: boolean; createdAt: string }[];
  _count: { messages: number };
}

export interface SupportTicketDetail extends Omit<SupportTicketSummary, 'messages' | '_count'> {
  messages: {
    id: string;
    body: string;
    isStaff: boolean;
    createdAt: string;
    author: { id: string; username: string; globalRole: string };
  }[];
}

// Public-exposure plan — GET/POST/PATCH/DELETE /api/admin/gateways.
export interface AdminGateway {
  id: string;
  name: string;
  publicHost: string;
  tunnelIp: string;
  controlUrl: string;
  isActive: boolean;
  lastAppliedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface ServerTransfer {
  id: string;
  serverId: string;
  sourceNodeId: string;
  targetNodeId: string;
  status: string;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  globalRole: string;
  isActive: boolean;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  serverCount: number;
  twoFactorEnabled: boolean;
}

// `id` is a BigInt column; the API's global toJSON polyfill renders it as a
// string, so it is never a JS number here.
export interface AdminAuditLog {
  id: string;
  occurredAt: string;
  action: string;
  actorEmail: string | null;
  actorIp: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  actor: { id: string; username: string; email: string } | null;
}

export interface SigningKey {
  kid: string;
  publicKey: string;
  state: string;
}

export interface PartitionInfo {
  table: string;
  range: string | null;
}

export interface ReadyzResponse {
  status: string;
  dependencies: {
    database: { ok: boolean; error?: string };
    redis: { ok: boolean; error?: string };
  };
}

// ─────────────────── COMMERCIAL SITE (subscriptions) ────────────────────

// GET /api/public/plans[/:slug] — the vitrine a visitor sees before ever
// logging in. Superset of ClientPlan's public-facing fields plus the
// commercial-site-only additions (highlight, sort order, availability);
// deliberately never includes maxSlots itself (see the API's
// PLAN_PUBLIC_SELECT doc comment) — availability is the only vagas
// signal a visitor gets.
export interface PlanAvailability {
  status: 'available' | 'limited' | 'sold_out';
  remaining: number | null;
}

export interface PublicPlan {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  memoryMb: number;
  diskMb: number;
  cpuLimitPercent: number;
  maxBackups: number;
  maxDatabases: number;
  maxSchedules: number;
  backupRetentionDays: number;
  hardwareLabel: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  currency: string;
  billingPeriod: string;
  maxServers: number | null;
  isFeatured: boolean;
  highlightLabel: string | null;
  sortOrder: number;
  recommendedPlayersMin: number | null;
  recommendedPlayersMax: number | null;
  recommendedModsMin: number | null;
  recommendedModsMax: number | null;
  recommendedPluginsMin: number | null;
  recommendedPluginsMax: number | null;
  availability: PlanAvailability;
  // Checkout redesign (WHMCS-style) — ONLY present on `GET
  // /api/public/plans/:slug` (PublicPlansService.getBySlug's own doc
  // comment), never on the list endpoint. Every public plan sharing this
  // one's billing family, itself included, ordered by price — lets the
  // checkout render a cycle switcher without navigating routes.
  familyCycles?: PublicPlan[];
}

// GET /api/public/templates — the software catalog a customer picks from
// at checkout (never installScript/dockerImages/node-shaped fields, see
// the API's PublicTemplatesService doc comment). `options` are the
// template's own customer-editable variables, already translated into a
// form-ready shape by the SAME `rules` string the backend validates
// against on submit — see `deriveOptionShape` there.
export type PublicTemplateOptionKind = 'text' | 'integer' | 'boolean' | 'choice';

export interface PublicTemplateOption {
  envVariable: string;
  name: string;
  description: string | null;
  defaultValue: string;
  kind: PublicTemplateOptionKind;
  required: boolean;
  min?: number;
  max?: number;
  choices?: string[];
}

export interface PublicTemplate {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  softwareKind: string | null;
  group: { id: string; name: string; iconUrl: string | null };
  options: PublicTemplateOption[];
}

// GET/POST /api/client/orders, /api/client/checkout — Checkout Bricks:
// Pix returns its QR inline, boleto returns its hosted ticket/line and
// card returns the provider's hosted authorization URL.
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded' | 'expired';
export type OrderProvisioningStatus = 'not_required' | 'pending' | 'running' | 'done' | 'failed';

export interface Order {
  id: string;
  externalReference: string;
  planId: string;
  subscriptionId: string | null;
  serverId: string | null;
  kind: 'plan_initial' | 'plan_renewal' | 'addon';
  amountCents: number;
  currency: string;
  status: OrderStatus;
  provider: string;
  checkoutUrl: string | null;
  pixQrCode: string | null;
  pixQrCodeBase64: string | null;
  boletoDigitableLine: string | null;
  boletoUrl: string | null;
  paymentMethod: 'pix' | 'boleto' | 'card' | null;
  paymentProvider: 'mercadopago' | 'pagbank';
  installments: number | null;
  paidAmountCents: number | null;
  paidAt: string | null;
  expiresAt: string | null;
  provisioningStatus: OrderProvisioningStatus;
  provisioningError: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

// GET /api/admin/orders — one Mercado Pago charge attempt against an order
// (an order can have several over its renewal history). Never card
// data — see Payment's own backend doc comment.
export interface Payment {
  id: string;
  orderId: string;
  status: string;
  statusDetail: string | null;
  amountCents: number;
  paidAmountCents: number | null;
  currency: string;
  paymentMethodId: string | null;
  installments: number | null;
  approvedAt: string | null;
  refundedAmountCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentWebhookEvent {
  id: string;
  provider: string;
  type: string;
  action: string | null;
  dataId: string | null;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface AdminOrder extends Order {
  user: { id: string; email: string; username: string };
  plan: { id: string; name: string };
  server: { id: string; name: string; nodeId: string } | null;
}

export interface AdminOrderDetail extends AdminOrder {
  payments: Payment[];
  webhookEvents: PaymentWebhookEvent[];
}

export type SubscriptionStatus = 'pending' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'expired';

// The plan fields a subscription's own detail view needs — never the
// node-tuning columns, mirrors the API's SUBSCRIPTION_PLAN_SELECT.
export interface SubscriptionPlanSummary {
  id: string;
  name: string;
  slug: string;
  memoryMb: number;
  diskMb: number;
  cpuLimitPercent: number;
}

export interface SubscriptionEvent {
  id: string;
  subscriptionId: string;
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus;
  actorId: string | null;
  reason: string | null;
  createdAt: string;
}

// GET/POST /api/client/subscriptions — price/currency/billingPeriod are
// snapshotted at contract time (never re-read from the plan later, same
// doctrine as Server.memoryMb being a snapshot of Plan.memoryMb).
export interface Subscription {
  id: string;
  userId: string;
  planId: string;
  serverId: string | null;
  status: SubscriptionStatus;
  priceCents: number;
  currency: string;
  billingPeriod: string;
  startedAt: string | null;
  currentPeriodEndsAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  // Checkout Bricks pivot: 'card' auto-renews via Mercado Pago's own
  // preapproval (autoRenew true, externalSubscriptionId set); 'pix'
  // renews only when the customer pays a new order (renewForUser).
  paymentMethod: 'pix' | 'boleto' | 'card' | null;
  externalSubscriptionId: string | null;
  autoRenew: boolean;
  firstChargePending: boolean;
  createdAt: string;
  updatedAt: string;
  plan: SubscriptionPlanSummary;
}

export interface SubscriptionDetail extends Subscription {
  events: SubscriptionEvent[];
}

export interface AdminSubscription extends Subscription {
  user: { id: string; email: string; username: string };
}

export interface AdminSubscriptionDetail extends AdminSubscription {
  events: SubscriptionEvent[];
}

export interface AdminSubscriptionList {
  items: AdminSubscription[];
  total: number;
  limit: number;
  offset: number;
}

// ───────────────── SITE ANNOUNCEMENT + NODE STATUS ──────────────────

// GET/PATCH /api/admin/site-announcement — the full row, admin-only.
export interface SiteAnnouncement {
  id: string;
  message: string;
  isActive: boolean;
  updatedAt: string;
}

// GET /api/public/status/announcement — `null` means "nothing to show,"
// the frontend's whole contract: render if non-null, never a separate
// isActive check on top (mirrors PublicStatusService.getPublic's own
// doc comment on the API side).
export interface PublicAnnouncement {
  message: string;
  updatedAt: string;
}

// GET /api/public/status/nodes — ONE aggregate across every public node
// platform-wide, never a raw node/location name (see
// PublicStatusService's own doc comment for why). `null` means zero
// public nodes exist anywhere yet.
export type PlatformStatusLevel = 'operational' | 'maintenance' | 'offline';

export interface PublicPlatformStatus {
  status: PlatformStatusLevel;
  // The nearest FUTURE scheduled maintenance across every public node,
  // or null — only ever set when `status !== 'maintenance'` (see
  // PublicStatusService's own doc comment).
  nextMaintenanceAt: string | null;
}
