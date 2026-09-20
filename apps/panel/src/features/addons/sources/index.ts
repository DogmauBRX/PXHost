import { Package, Search, Upload } from 'lucide-react';
import type { AddonSource } from '../addons.types';
import { InstalledPanel } from './installed';
import { UploadPanel } from './upload';
import { ModrinthPluginsPanel } from './modrinth';

// Modrinth/CurseForge catalog source goes here later: one file + one entry.
// Nothing in AddonsPage, the tab bar, or the routes needs to change.
export const ADDON_SOURCES: AddonSource[] = [
  { id: 'installed', label: 'Instalados', icon: Package, available: () => true, Panel: InstalledPanel },
  { id: 'modrinth', label: 'Modrinth', icon: Search, available: (ctx) => ctx.software.addonNoun === 'plugin' && ctx.permissions.includes('addons.catalog.read'), Panel: ModrinthPluginsPanel },
  { id: 'upload', label: 'Enviar arquivo', icon: Upload, available: (ctx) => ctx.permissions.includes('file.write'), Panel: UploadPanel },
];
