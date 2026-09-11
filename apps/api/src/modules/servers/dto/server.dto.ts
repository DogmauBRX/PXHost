import { IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateServerDto {
  @IsUUID()
  ownerId!: string;

  // Capacity plan Fase 5: omitted ⇒ automatic node selection
  // (NodeSchedulerService). Every existing caller already sends this,
  // so nothing changes for them.
  @IsOptional()
  @IsUUID()
  nodeId?: string;

  @IsUUID()
  templateId!: string;

  @IsUUID()
  planId!: string;

  @IsString()
  @Length(1, 191)
  name!: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @IsOptional()
  @IsUUID()
  allocationId?: string;

  // Payments plan step 6: when set, `createOnNode` attaches the new
  // server to this subscription (`subscription.server_id`) in the SAME
  // transaction that creates the server — see CapacityService.
  // occupiedSlots' own doc comment for why that has to be one
  // transaction, not two (a subscription with `serverId` set drops out
  // of the "pending subscriptions hold a slot" count the instant a
  // server picks that slot up instead; doing the two writes in separate
  // transactions would momentarily double-count). Set by
  // `ProvisioningService` after a checkout payment is confirmed; an
  // admin creating a server by hand may also use it (e.g. attaching an
  // existing subscription to a manually-created replacement server),
  // same trust level as every other field on this admin/internal DTO.
  @IsOptional()
  @IsUUID()
  attachSubscriptionId?: string;
}

/**
 * Internal-only — never bound by a `ValidationPipe` (ProvisioningService
 * calls `ServersService.createSetupPending` directly, not over HTTP).
 * Deliberately much smaller than `CreateServerDto`: no `templateId`, no
 * required `name` — a post-purchase server reserves its plan slot and
 * node capacity before the customer has chosen either (see the
 * 'setup_pending' status and `ServerSetupService.complete`, which is
 * the only path that ever fills those in).
 */
export interface CreateSetupPendingServerInput {
  ownerId: string;
  planId: string;
  nodeId?: string;
  name?: string;
  attachSubscriptionId?: string;
}

export class SuspendServerDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}
