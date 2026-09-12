import { ArrayMaxSize, ArrayMinSize, IsUUID } from 'class-validator';

/** Bulk-archive request from the admin Payments page's checkbox selection. Capped at 200 — the same order of magnitude as a single admin listing page, never an unbounded batch. */
export class ArchiveOrdersDto {
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  ids!: string[];
}
