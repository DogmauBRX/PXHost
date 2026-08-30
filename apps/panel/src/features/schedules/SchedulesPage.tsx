import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addTask, createSchedule, deleteSchedule, deleteTask, listSchedules, updateSchedule } from './schedules.api';
import { Button } from '@/ui/primitives/Button';
import { ApiError } from '@/shared/api/client';
import type { TaskAction } from '@/shared/api/types';

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('pt-BR') : '—';
}

const TASK_LABELS: Record<TaskAction, string> = { power: 'Reiniciar servidor', backup: 'Criar backup' };
const STATUS_LABELS: Record<string, string> = { success: 'Sucesso', failed: 'Falhou', skipped: 'Ignorado' };

export function SchedulesPage({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const { data: schedules, isLoading, isError } = useQuery({ queryKey: ['schedules', serverId], queryFn: () => listSchedules(serverId) });
  const [name, setName] = useState('');
  const [hour, setHour] = useState('3');
  const [minute, setMinute] = useState('0');
  const [onlyWhenOnline, setOnlyWhenOnline] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['schedules', serverId] });
  }

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createSchedule(serverId, { name: name.trim(), cronHour: hour, cronMinute: minute, onlyWhenOnline });
      setName('');
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o agendamento.');
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(id: string, isActive: boolean) {
    setError(null);
    try {
      await updateSchedule(serverId, id, { isActive: !isActive });
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível atualizar o agendamento.');
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Excluir este agendamento e todas as suas tarefas?')) return;
    setError(null);
    try {
      await deleteSchedule(serverId, id);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir o agendamento.');
    }
  }

  async function handleAddTask(scheduleId: string, action: TaskAction) {
    setError(null);
    try {
      await addTask(serverId, scheduleId, action);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível adicionar a tarefa.');
    }
  }

  async function handleDeleteTask(scheduleId: string, taskId: string) {
    setError(null);
    try {
      await deleteTask(serverId, scheduleId, taskId);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível remover a tarefa.');
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="font-medium text-text">Agendamentos</h1>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Nome</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Reinício noturno" className="w-48 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Hora</label>
          <input value={hour} onChange={(e) => setHour(e.target.value)} className="w-16 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Minuto</label>
          <input value={minute} onChange={(e) => setMinute(e.target.value)} className="w-16 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-text-muted">
          <input type="checkbox" checked={onlyWhenOnline} onChange={(e) => setOnlyWhenOnline(e.target.checked)} />
          Só executar se o servidor estiver online
        </label>
        <Button variant="primary" disabled={creating} onClick={() => void handleCreate()}>
          {creating ? 'Criando…' : 'Criar agendamento'}
        </Button>
      </div>

      {error && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{error}</p>}

      <div className="min-h-0 flex-1 space-y-3 overflow-auto">
        {isLoading && <p className="text-sm text-text-muted">Carregando…</p>}
        {isError && <p className="text-sm text-fail">Não foi possível carregar os agendamentos.</p>}
        {schedules && schedules.length === 0 && <p className="text-sm text-text-muted">Nenhum agendamento ainda.</p>}
        {schedules?.map((s) => (
          <div key={s.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-text">{s.name}</p>
                <p className="font-mono text-xs text-text-faint">
                  {s.cronMinute} {s.cronHour} {s.cronDayOfMonth} {s.cronMonth} {s.cronDayOfWeek} · {s.timezone}
                  {s.onlyWhenOnline && ' · somente online'}
                </p>
                <p className="text-xs text-text-faint">
                  Próxima execução: {formatDate(s.nextRunAt)} · Última: {formatDate(s.lastRunAt)}
                  {s.lastRunStatus && ` (${STATUS_LABELS[s.lastRunStatus] ?? s.lastRunStatus})`}
                  {s.isProcessing && ' · executando agora'}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="secondary" onClick={() => void handleToggleActive(s.id, s.isActive)}>
                  {s.isActive ? 'Ativo' : 'Inativo'}
                </Button>
                <Button variant="ghost" onClick={() => void handleDelete(s.id)}>
                  Excluir
                </Button>
              </div>
            </div>

            <div className="mt-3 space-y-1">
              {s.tasks.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-1.5 text-sm">
                  <span className="text-text">
                    {t.sequenceNumber}. {TASK_LABELS[t.action]}
                  </span>
                  <Button variant="ghost" onClick={() => void handleDeleteTask(s.id, t.id)}>
                    Remover
                  </Button>
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <Button variant="secondary" onClick={() => void handleAddTask(s.id, 'power')}>
                  + Reiniciar
                </Button>
                <Button variant="secondary" onClick={() => void handleAddTask(s.id, 'backup')}>
                  + Backup
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
