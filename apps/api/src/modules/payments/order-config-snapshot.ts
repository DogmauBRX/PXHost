/**
 * The shape `Order.config` is written in (`OrdersService.
 * createCheckoutOrder`) and read back in (`ProvisioningService.
 * provisionOrder`) — a single shared type so the writer and the reader
 * of this JSON column can never silently drift apart. Immutable once
 * written: an admin editing the Plan or Template later must never
 * retroactively change what an already-placed order provisions
 * (architecture doc 2.1's "snapshot, not reference" doctrine, the same
 * one `Server`'s own plan-derived columns already follow).
 */
export interface OrderConfigSnapshot {
  serverName: string;
  template: { id: string; name: string; groupId: string; groupName: string };
  variables: Record<string, string>;
  plan: { id: string; name: string; memoryMb: number; diskMb: number; cpuLimitPercent: number };
}
