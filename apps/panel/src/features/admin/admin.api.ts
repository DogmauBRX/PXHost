import { apiFetch, API_URL } from '@/shared/api/client';
import type {
  Allocation,
  AdminNode,
  AdminPlan,
  AdminAuditLog,
  AdminServerDetail,
  AdminServerSummary,
  AdminTemplate,
  AdminUserSummary,
  BootstrapTokenResponse,
  CapacityDashboard,
  CapacitySimulateResult,
  Location,
  NodeCapacitySnapshot,
  Paginated,
  PartitionInfo,
  PlanApplyResult,
  PlanDriftReport,
  PlanOccupancy,
  SoftwareKind,
  ReadyzResponse,
  ServerTransfer,
  SigningKey,
  TemplateGroup,
} from '@/shared/api/types';

// ---- Locations ----

export const listLocations = () => apiFetch<Location[]>('/api/admin/locations');
export const createLocation = (input: { shortCode: string; name: string; country?: string }) =>
  apiFetch<Location>('/api/admin/locations', { method: 'POST', body: JSON.stringify(input) });

// ---- Nodes ----

export interface CreateNodeInput {
  locationId: string;
  name: string;
  fqdn: string;
  scheme?: 'http' | 'https';
  daemonPort?: number;
  memoryTotalMb: number;
  diskTotalMb: number;
}

// Capacity plan Fase 3 — every field a node's commercial-capacity edit
// screen can touch. Deliberately a separate interface from
// `CreateNodeInput` (matches `UpdateTemplateInput`'s sibling pattern,
// not `Partial<CreateNodeInput>`): the backend's `UpdateNodeDto` covers
// a different field set than create does (no locationId/fqdn/scheme —
// those aren't editable post-bootstrap — but adds maintenanceMode and
// every reserve/overallocate/cpuTotal field create also has).
export interface UpdateNodeInput {
  name?: string;
  description?: string;
  isPublic?: boolean;
  maintenanceMode?: boolean;
  memoryTotalMb?: number;
  memoryReservedMb?: number;
  memoryOverallocatePct?: number;
  diskTotalMb?: number;
  diskReservedMb?: number;
  diskOverallocatePct?: number;
  cpuTotalPercent?: number;
  cpuReservedPercent?: number;
  cpuOverallocatePct?: number;
}

export const listNodes = () => apiFetch<AdminNode[]>('/api/admin/nodes');
export const getNode = (id: string) => apiFetch<AdminNode>(`/api/admin/nodes/${id}`);
export const createNode = (input: CreateNodeInput) => apiFetch<AdminNode>('/api/admin/nodes', { method: 'POST', body: JSON.stringify(input) });
export const updateNode = (id: string, input: UpdateNodeInput) => apiFetch<AdminNode>(`/api/admin/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
export const deleteNode = (id: string) => apiFetch<void>(`/api/admin/nodes/${id}`, { method: 'DELETE' });
export const issueBootstrapToken = (nodeId: string) => apiFetch<BootstrapTokenResponse>(`/api/admin/nodes/${nodeId}/bootstrap-token`, { method: 'POST' });
/** Compromise response (roadmap M13): kills the node's current token immediately and returns a fresh bootstrap token for manual re-onboarding — same response shape as issueBootstrapToken. */
export const rotateNodeToken = (nodeId: string) => apiFetch<BootstrapTokenResponse>(`/api/admin/nodes/${nodeId}/rotate-token`, { method: 'POST' });
export const listAllocations = (nodeId: string) => apiFetch<Allocation[]>(`/api/admin/nodes/${nodeId}/allocations`);
export const createAllocationRange = (nodeId: string, input: { ip: string; startPort: number; endPort: number }) =>
  apiFetch<{ created: number; skippedExisting: number }>(`/api/admin/nodes/${nodeId}/allocations`, { method: 'POST', body: JSON.stringify(input) });

// ---- Templates (nests/eggs) ----

export const listTemplateGroups = () => apiFetch<TemplateGroup[]>('/api/admin/nests');
export const createTemplateGroup = (input: { name: string; description?: string }) => apiFetch<TemplateGroup>('/api/admin/nests', { method: 'POST', body: JSON.stringify(input) });

export const listTemplates = (groupId?: string) => apiFetch<AdminTemplate[]>(`/api/admin/eggs${groupId ? `?groupId=${groupId}` : ''}`);
export interface CreateTemplateInput {
  groupId: string;
  name: string;
  author: string;
  description?: string;
  dockerImages: Record<string, string>;
  startupCommand: string;
  stopCommand?: string;
  installImage?: string;
  installEntrypoint?: string;
  installScript: string;
  softwareKind?: SoftwareKind;
}
export const createTemplate = (input: CreateTemplateInput) => apiFetch<AdminTemplate>('/api/admin/eggs', { method: 'POST', body: JSON.stringify(input) });
export const addTemplateVariable = (
  templateId: string,
  input: { name: string; envVariable: string; defaultValue?: string; description?: string; isUserViewable?: boolean; isUserEditable?: boolean },
) => apiFetch(`/api/admin/eggs/${templateId}/variables`, { method: 'POST', body: JSON.stringify(input) });
export const removeTemplateVariable = (templateId: string, variableId: string) => apiFetch<void>(`/api/admin/eggs/${templateId}/variables/${variableId}`, { method: 'DELETE' });

export interface UpdateTemplateInput {
  name?: string;
  author?: string;
  groupId?: string;
  description?: string;
  dockerImages?: Record<string, string>;
  startupCommand?: string;
  stopCommand?: string;
  installImage?: string;
  installEntrypoint?: string;
  installScript?: string;
  softwareKind?: SoftwareKind;
  isActive?: boolean;
}
export const updateTemplate = (id: string, input: UpdateTemplateInput) =>
  apiFetch<AdminTemplate>(`/api/admin/eggs/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
export const removeTemplate = (id: string) => apiFetch<void>(`/api/admin/eggs/${id}`, { method: 'DELETE' });

// ---- Plans ----

export const listPlans = () => apiFetch<AdminPlan[]>('/api/admin/plans');
export interface CreatePlanInput {
  name: string;
  slug: string;
  description?: string;
  isPublic?: boolean;
  sortOrder?: number;
  cpuLimitPercent?: number;
  memoryMb: number;
  swapMb?: number;
  diskMb: number;
  ioWeight?: number;
  maxDatabases?: number;
  maxBackups?: number;
  maxAllocations?: number;
  maxSchedules?: number;
  backupRetentionDays?: number;
  priceCents?: number;
  currency?: string;
  billingPeriod?: string;
  maxServers?: number;
  maxSlots?: number;
  recommendedPlayersMin?: number;
  recommendedPlayersMax?: number;
  recommendedModsMin?: number;
  recommendedModsMax?: number;
  recommendedPluginsMin?: number;
  recommendedPluginsMax?: number;
}
export const createPlan = (input: CreatePlanInput) => apiFetch<AdminPlan>('/api/admin/plans', { method: 'POST', body: JSON.stringify(input) });
export const updatePlan = (id: string, input: Partial<CreatePlanInput>) => apiFetch<AdminPlan>(`/api/admin/plans/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
export const getPlanDrift = (id: string) => apiFetch<PlanDriftReport>(`/api/admin/plans/${id}/drift`);
export const applyPlan = (id: string) => apiFetch<PlanApplyResult>(`/api/admin/plans/${id}/apply`, { method: 'POST' });

// ---- Capacity (read-only — see apps/api/src/modules/capacity) ----

export const getCapacityDashboard = () => apiFetch<CapacityDashboard>('/api/admin/capacity');
export const getNodeCapacity = (nodeId: string) => apiFetch<NodeCapacitySnapshot>(`/api/admin/capacity/nodes/${nodeId}`);
export const getPlanCapacity = () => apiFetch<PlanOccupancy[]>('/api/admin/capacity/plans');
export const simulateCapacity = (input: { planId: string; nodeId?: string }) =>
  apiFetch<CapacitySimulateResult>('/api/admin/capacity/simulate', { method: 'POST', body: JSON.stringify(input) });

// ---- Servers (admin-side create, used to onboard a demo server if needed) ----

export const listAdminServers = (ownerId?: string) => apiFetch<AdminServerSummary[]>(`/api/admin/servers${ownerId ? `?ownerId=${ownerId}` : ''}`);
export const getAdminServer = (id: string) => apiFetch<AdminServerDetail>(`/api/admin/servers/${id}`);
export interface CreateAdminServerInput {
  ownerId: string;
  // Capacity plan Fase 5: omitted ⇒ automatic node selection (NodeSchedulerService).
  nodeId?: string;
  templateId: string;
  planId: string;
  name: string;
}
export const createAdminServer = (input: CreateAdminServerInput) =>
  apiFetch<{ id: string; shortId: string; status: string }>('/api/admin/servers', { method: 'POST', body: JSON.stringify(input) });

// ---- Node-to-node transfer (roadmap M13) ----

export const listTransfers = (serverId: string) => apiFetch<ServerTransfer[]>(`/api/admin/servers/${serverId}/transfer`);
export const initiateTransfer = (serverId: string, input: { targetNodeId: string }) =>
  apiFetch<{ id: string; status: string }>(`/api/admin/servers/${serverId}/transfer`, { method: 'POST', body: JSON.stringify(input) });

// ---- Suspend / restore (roadmap M14) ----

export const suspendServer = (serverId: string, reason: string) =>
  apiFetch<void>(`/api/admin/servers/${serverId}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) });
export const unsuspendServer = (serverId: string) => apiFetch<void>(`/api/admin/servers/${serverId}/unsuspend`, { method: 'POST' });

// ---- Users / clientes ----

function qs(params: object): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  return pairs.length ? `?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
}

export interface ListUsersParams {
  q?: string;
  role?: string;
  limit?: number;
  offset?: number;
}
export const listUsers = (params: ListUsersParams = {}) =>
  apiFetch<Paginated<AdminUserSummary>>(`/api/admin/users${qs(params)}`);

export interface CreateUserInput {
  email: string;
  username: string;
  password: string;
  firstName?: string;
  lastName?: string;
  globalRole?: string;
}
export const createUser = (input: CreateUserInput) =>
  apiFetch<AdminUserSummary>('/api/admin/users', { method: 'POST', body: JSON.stringify(input) });

export interface UpdateUserInput {
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  globalRole?: string;
}
export const updateUser = (id: string, input: UpdateUserInput) =>
  apiFetch<AdminUserSummary>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

export const blockUser = (id: string) => apiFetch<void>(`/api/admin/users/${id}/block`, { method: 'POST' });
export const unblockUser = (id: string) => apiFetch<void>(`/api/admin/users/${id}/unblock`, { method: 'POST' });

// ---- Audit logs ----

export interface ListAuditLogsParams {
  action?: string;
  actorId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
export const listAuditLogs = (params: ListAuditLogsParams = {}) =>
  apiFetch<Paginated<AdminAuditLog>>(`/api/admin/audit-logs${qs(params)}`);

// ---- System: signing keys (JWKS) ----

export const listSigningKeys = () => apiFetch<SigningKey[]>('/api/admin/security/signing-keys');
export const rotateSigningKey = () => apiFetch<{ kid: string }>('/api/admin/security/signing-keys/rotate', { method: 'POST' });
export const retireSigningKey = (kid: string) =>
  apiFetch<void>(`/api/admin/security/signing-keys/${kid}/retire`, { method: 'POST' });

// ---- System: log partitions ----

export const listPartitions = () => apiFetch<PartitionInfo[]>('/api/admin/partitions');
export const maintainPartitions = () => apiFetch<void>('/api/admin/partitions/maintain', { method: 'POST' });

// ---- System: infra health (public endpoint, outside /api) ----

export const getReadyz = () => fetch(`${API_URL}/readyz`).then((r) => r.json() as Promise<ReadyzResponse>);
