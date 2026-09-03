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
}

// Mirrors apps/api/src/modules/templates/software.ts's describeSoftware()
// output — the ONE place "/plugins" vs "/mods" is decided. Never re-derive
// this on the frontend; always read it off the server response.
export type SoftwareKind = 'paper' | 'purpur' | 'spigot' | 'bukkit' | 'fabric' | 'forge' | 'neoforge' | 'vanilla' | 'bungeecord' | 'velocity' | 'other';

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
  backupRetentionDays: number;
  priceCents: number;
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
}

export interface ServerDetail extends ServerSummary {
  node: { id: string; name: string; fqdn: string; scheme: string; daemonPort: number };
  role: 'owner' | 'subuser' | 'admin';
  /** Every permission key this caller actually holds — lets the UI hide an action instead of showing a button that 403s. Affordance only; the backend still enforces it. */
  permissions: string[];
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
  healthStatus: string;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  createdAt: string;
  // Capacity plan Fase 2/7: what the agent ACTUALLY reports, distinct
  // from the declared columns above. Null until an agent new enough to
  // send them heartbeats at least once — never copied into the declared
  // fields, and never the number a capacity ceiling is computed from.
  reportedMemoryTotalMb: number | null;
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
  status: 'normal' | 'warning' | 'critical';
}

export interface NodeCapacitySnapshot {
  id: string;
  name: string;
  healthStatus: string;
  maintenanceMode: boolean;
  isPublic: boolean;
  serverCount: number;
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

export interface PlanOccupancy {
  id: string;
  name: string;
  slug: string;
  isPublic: boolean;
  memoryMb: number;
  diskMb: number;
  cpuLimitPercent: number;
  occupied: number;
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
  priceCents: number;
  currency: string;
  billingPeriod: string;
  maxServers: number | null;
  // Capacity plan Fase 4 — commercial stock. null = unlimited.
  // Deliberately absent from `ClientPlan` above (remaining stock is a
  // live query, not something this static field alone can render
  // meaningfully to a customer — see the capacity plan's own
  // "Pontos em aberto").
  maxSlots: number | null;
  recommendedPlayersMin: number | null;
  recommendedPlayersMax: number | null;
  recommendedModsMin: number | null;
  recommendedModsMax: number | null;
  recommendedPluginsMin: number | null;
  recommendedPluginsMax: number | null;
  createdAt: string;
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
