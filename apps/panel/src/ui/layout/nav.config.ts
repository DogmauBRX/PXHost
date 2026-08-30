import {
  HardDrive,
  Layers,
  LayoutDashboard,
  MapPin,
  Package,
  ScrollText,
  Server,
  ServerCog,
  Settings,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { LinkProps } from '@tanstack/react-router';

export interface NavItem {
  label: string;
  to: LinkProps['to'];
  icon: LucideIcon;
  adminOnly?: boolean;
  /** Match the path exactly rather than fuzzily — needed for index routes. */
  exact?: boolean;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * `as const` matters: `<Link to>` is typed against the generated route tree,
 * so a widened `string` would not compile. The existing TABS arrays use the
 * same trick for the same reason.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'principal',
    label: 'Principal',
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard, exact: true },
      { label: 'Servidores', to: '/servers', icon: Server },
      { label: 'Locations', to: '/admin', icon: MapPin, adminOnly: true, exact: true },
      { label: 'Nodes', to: '/admin/nodes', icon: HardDrive, adminOnly: true },
    ],
  },
  {
    id: 'gerenciamento',
    label: 'Gerenciamento',
    items: [
      { label: 'Templates', to: '/admin/templates', icon: Package, adminOnly: true },
      { label: 'Plans', to: '/admin/plans', icon: Layers, adminOnly: true },
      // Distinct from "Servidores" above: that one is the customer's own
      // list, this is the admin-wide view with transfer/suspend controls.
      { label: 'Todos os servidores', to: '/admin/servers', icon: ServerCog, adminOnly: true },
      { label: 'Clientes', to: '/admin/users', icon: Users, adminOnly: true },
    ],
  },
  {
    id: 'sistema',
    label: 'Sistema',
    items: [
      { label: 'Configurações', to: '/settings', icon: Settings },
      { label: 'Logs', to: '/admin/logs', icon: ScrollText, adminOnly: true },
    ],
  },
];

/** Drops admin-only entries (and any section left empty) for non-admins. */
export function visibleSections(isAdmin: boolean): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.adminOnly || isAdmin),
  })).filter((section) => section.items.length > 0);
}
