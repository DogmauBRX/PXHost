import { PageHeader } from '@/ui/primitives';
import { ServerList } from './ServerList';

export function ServersPage() {
  return (
    <>
      <PageHeader title="Servidores" subtitle="Todos os servidores aos quais você tem acesso." />
      <ServerList />
    </>
  );
}
