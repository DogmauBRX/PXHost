import {
  CalendarClock,
  CreditCard,
  HardDrive,
  LayoutDashboard,
  Layers,
  LifeBuoy,
  MapPin,
  Package,
  ScrollText,
  Server,
  ServerCog,
  Settings,
  ShieldCheck,
  User,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { LinkProps } from '@tanstack/react-router';

export interface NavItem {
  label: string;
  to: LinkProps['to'];
  icon: LucideIcon;
  /** Match the path exactly rather than fuzzily — needed for index routes. */
  exact?: boolean;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * Two genuinely separate trees, not one array filtered by role. Admin and
 * client are different products wearing the same visual system — sharing a
 * data structure between them just to delete half of it at render time was
 * the old design's actual bug (a client and an admin landed on the exact
 * same `/` before this rework), not a simplification worth keeping.
 *
 * `as const` matters: `<Link to>` is typed against the generated route tree,
 * so a widened `string` would not compile.
 */
export const ADMIN_NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'principal',
    label: 'Principal',
    items: [
      { label: 'Dashboard', to: '/admin', icon: LayoutDashboard, exact: true },
      { label: 'Servidores', to: '/admin/servers', icon: ServerCog },
      { label: 'Nodes', to: '/admin/nodes', icon: HardDrive },
      { label: 'Locations', to: '/admin/locations', icon: MapPin },
    ],
  },
  {
    id: 'gerenciamento',
    label: 'Gerenciamento',
    items: [
      { label: 'Clientes', to: '/admin/users', icon: Users },
      { label: 'Templates', to: '/admin/templates', icon: Package },
      { label: 'Plans', to: '/admin/plans', icon: Layers },
    ],
  },
  {
    id: 'sistema',
    label: 'Sistema',
    items: [
      { label: 'Configurações', to: '/admin/settings', icon: Settings },
      { label: 'Logs', to: '/admin/logs', icon: ScrollText },
      { label: 'Sistema', to: '/admin/system', icon: ShieldCheck },
    ],
  },
];

export const CLIENT_NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'principal',
    label: 'Principal',
    items: [
      { label: 'Dashboard', to: '/client', icon: LayoutDashboard, exact: true },
      { label: 'Meus Servidores', to: '/client/servers', icon: Server },
    ],
  },
  {
    id: 'conta',
    label: 'Conta',
    items: [
      { label: 'Minha Conta', to: '/client/settings', icon: User },
      { label: 'Plano', to: '/client/plan', icon: CalendarClock },
      { label: 'Faturamento', to: '/client/billing', icon: CreditCard },
    ],
  },
  {
    id: 'suporte',
    label: 'Suporte',
    items: [{ label: 'Suporte', to: '/client/support', icon: LifeBuoy }],
  },
];
