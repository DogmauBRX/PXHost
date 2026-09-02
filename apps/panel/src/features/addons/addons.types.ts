import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { ServerDetail, SoftwareInfo } from '@/shared/api/types';

export interface AddonContext {
  server: ServerDetail;
  permissions: string[];
  software: SoftwareInfo;
}

export interface AddonSourcePanelProps {
  serverId: string;
  ctx: AddonContext;
}

/**
 * One tab of the Add-ons page. Adding a catalog source later (Modrinth) is
 * one new file plus one entry in ADDON_SOURCES — nothing in AddonsPage, the
 * tab bar, or the routes changes.
 */
export interface AddonSource {
  id: string;
  label: string;
  icon: LucideIcon;
  available: (ctx: AddonContext) => boolean;
  Panel: ComponentType<AddonSourcePanelProps>;
}
