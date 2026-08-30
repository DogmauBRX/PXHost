export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; username: string; globalRole: string };
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
  node: { id: string; name: string };
  plan: { id: string; name: string } | null;
}

export interface ServerDetail extends ServerSummary {
  node: { id: string; name: string; fqdn: string; scheme: string; daemonPort: number };
  allocations: { ip: string; port: number; isPrimary: boolean }[];
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
  memoryTotalMb: number;
  memoryReservedMb: number;
  memoryOverallocatePct: number;
  diskTotalMb: number;
  diskReservedMb: number;
  diskOverallocatePct: number;
  cpuOverallocatePct: number;
  isPublic: boolean;
  maintenanceMode: boolean;
  healthStatus: string;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  createdAt: string;
}

export interface BootstrapTokenResponse {
  token: string;
  expiresAt: string;
  command: string;
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

export interface PlanDriftReport {
  plan: { id: string; name: string };
  affectedCount: number;
  servers: PlanDriftEntry[];
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
