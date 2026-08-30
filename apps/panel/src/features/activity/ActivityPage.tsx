import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { listActivity } from './activity.api';
import { ApiError } from '@/shared/api/client';
import { Alert, EmptyState, LoadingRow, PageHeader, TBody, TD, TR, Table, TableWrap } from '@/ui/primitives';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR');
}

const EVENT_LABELS: Record<string, string> = {
  'server.power.start': 'Iniciou o servidor',
  'server.power.stop': 'Parou o servidor',
  'server.power.restart': 'Reiniciou o servidor',
  'server.power.kill': 'Forçou a parada do servidor',
  'server.file.write': 'Editou um arquivo',
  'server.file.rename': 'Renomeou um arquivo',
  'server.file.delete': 'Excluiu um arquivo',
  'server.backup.create': 'Criou um backup',
  'server.backup.delete': 'Excluiu um backup',
  'server.backup.restore': 'Restaurou um backup',
  'server.database.create': 'Criou um banco de dados',
  'server.database.delete': 'Excluiu um banco de dados',
  'server.schedule.create': 'Criou um agendamento',
  'server.schedule.update': 'Atualizou um agendamento',
  'server.schedule.delete': 'Excluiu um agendamento',
  'server.schedule.task.create': 'Adicionou uma tarefa ao agendamento',
  'server.schedule.task.delete': 'Removeu uma tarefa do agendamento',
  'server.subuser.invite': 'Convidou um subusuário',
  'server.subuser.update': 'Atualizou permissões de um subusuário',
  'server.subuser.remove': 'Removeu um subusuário',
};

export function ActivityPage({ serverId }: { serverId: string }) {
  const { data: entries, isLoading, isError, error } = useQuery({ queryKey: ['activity', serverId], queryFn: () => listActivity(serverId) });

  return (
    <>
      <PageHeader title="Atividade" subtitle="Histórico de ações realizadas neste servidor." />

      {isError && (
        <Alert className="mb-6">
          {error instanceof ApiError && error.status === 403 ? 'Você não tem permissão para ver o feed de atividade.' : 'Não foi possível carregar a atividade.'}
        </Alert>
      )}

      {isLoading ? (
        <LoadingRow />
      ) : !entries || entries.length === 0 ? (
        <EmptyState icon={Activity} title="Nenhuma atividade ainda" description="Ações realizadas neste servidor aparecem aqui." />
      ) : (
        <TableWrap>
          <Table>
            <TBody>
              {entries.map((e) => (
                <TR key={e.id}>
                  <TD>
                    <p className="text-text">{EVENT_LABELS[e.event] ?? e.event}</p>
                    <p className="text-xs text-text-faint">
                      {e.actor ? `${e.actor.username} (${e.actor.email})` : 'Sistema'} · {formatDate(e.createdAt)}
                    </p>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
    </>
  );
}
