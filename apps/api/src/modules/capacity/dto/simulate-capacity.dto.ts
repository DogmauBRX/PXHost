import { IsOptional, IsUUID } from 'class-validator';

/**
 * Preview-only — never takes the node's advisory lock, never reserves
 * anything (see `nodeFitReasons`'s doc comment). `nodeId` omitted checks
 * every non-maintenance, public node; a real create still re-verifies
 * under lock and is the actual source of truth if this preview and the
 * eventual create disagree (a concurrent create between the two calls).
 */
export class SimulateCapacityDto {
  @IsUUID()
  planId!: string;

  @IsOptional()
  @IsUUID()
  nodeId?: string;
}
