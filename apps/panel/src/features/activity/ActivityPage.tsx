import { useQuery } from '@tanstack/react-query';
import { listActivity } from './activity.api';
import { ApiError } from '@/shared/api/client';

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
    <div className="flex h-full flex-col gap-4">
      <h1 className="font-medium text-text">Atividade</h1>

      {isError && (
        <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">
          {error instanceof ApiError && error.status === 403 ? 'Você não tem permissão para ver o feed de atividade.' : 'Não foi possível carregar a atividade.'}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface">
        {isLoading && <p className="p-4 text-sm text-text-muted">Carregando…</p>}
        {entries && entries.length === 0 && <p className="p-4 text-sm text-text-muted">Nenhuma atividade ainda.</p>}
        {entries && entries.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-2">
                    <p className="text-text">{EVENT_LABELS[e.event] ?? e.event}</p>
                    <p className="text-xs text-text-faint">
                      {e.actor ? `${e.actor.username} (${e.actor.email})` : 'Sistema'} · {formatDate(e.createdAt)}
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
