import { Link } from '@tanstack/react-router';
import type { AssistantRoute } from '@/shared/api/types';

interface AssistantRouteLinkProps {
  route: AssistantRoute;
  serverId: string;
  label: string;
  className?: string;
}

/**
 * The only place AssistantRoute (a closed enum the API controls) turns
 * into a real navigation. A `switch` with one `<Link>` literal per case —
 * not a lookup table of `{to, params}` objects — because each `to` needs
 * to stay a literal string for `@tanstack/router`'s route-tree typing to
 * actually check it; a generic factory would have to widen `to` to
 * `string` and lose that.
 */
export function AssistantRouteLink({ route, serverId, label, className }: AssistantRouteLinkProps) {
  switch (route) {
    case 'server.console':
      return <Link to="/client/servers/$serverId" params={{ serverId }} className={className}>{label}</Link>;
    case 'server.files':
      return <Link to="/client/servers/$serverId/files" params={{ serverId }} className={className}>{label}</Link>;
    case 'server.addons':
      return <Link to="/client/servers/$serverId/addons" params={{ serverId }} className={className}>{label}</Link>;
    case 'server.backups':
      return <Link to="/client/servers/$serverId/backups" params={{ serverId }} className={className}>{label}</Link>;
    case 'server.variables':
      return <Link to="/client/servers/$serverId/variables" params={{ serverId }} className={className}>{label}</Link>;
    case 'server.databases':
      return <Link to="/client/servers/$serverId/databases" params={{ serverId }} className={className}>{label}</Link>;
    case 'server.schedules':
      return <Link to="/client/servers/$serverId/schedules" params={{ serverId }} className={className}>{label}</Link>;
    case 'server.subusers':
      return <Link to="/client/servers/$serverId/subusers" params={{ serverId }} className={className}>{label}</Link>;
    case 'server.activity':
      return <Link to="/client/servers/$serverId/activity" params={{ serverId }} className={className}>{label}</Link>;
    case 'client.plan':
      return <Link to="/client/plan" className={className}>{label}</Link>;
    case 'client.support':
      return <Link to="/client/support" className={className}>{label}</Link>;
  }
}
