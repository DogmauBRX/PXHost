import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { addTask, createSchedule, deleteSchedule, deleteTask, listSchedules, updateSchedule } from './schedules.api';
import { ApiError } from '@/shared/api/client';
import type { TaskAction } from '@/shared/api/types';
import { Alert, Badge, Button, Card, CardBody, ConfirmDialog, EmptyState, Field, Input, LoadingRow, PageHeader } from '@/ui/primitives';

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
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

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

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setError(null);
    try {
      await deleteSchedule(serverId, deleteTarget);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir o agendamento.');
    } finally {
      setDeleteTarget(null);
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
    <>
      <PageHeader title="Agendamentos" subtitle="Tarefas automáticas executadas neste servidor." />

      <Card className="mb-6">
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Nome" htmlFor="sched-name" className="w-48">
            <Input id="sched-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Reinício noturno" />
          </Field>
          <Field label="Hora" htmlFor="sched-hour" className="w-20">
            <Input id="sched-hour" value={hour} onChange={(e) => setHour(e.target.value)} />
          </Field>
          <Field label="Minuto" htmlFor="sched-minute" className="w-20">
            <Input id="sched-minute" value={minute} onChange={(e) => setMinute(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 pb-2.5 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={onlyWhenOnline}
              onChange={(e) => setOnlyWhenOnline(e.target.checked)}
              className="h-4 w-4 rounded border-border-strong text-accent accent-accent"
            />
            Só executar se o servidor estiver online
          </label>
          <Button variant="primary" disabled={creating || !name.trim()} onClick={() => void handleCreate()}>
            {creating ? 'Criando…' : 'Criar agendamento'}
          </Button>
        </CardBody>
      </Card>

      {error && <Alert className="mb-6">{error}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os agendamentos.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : !schedules || schedules.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Nenhum agendamento ainda" description="Crie o primeiro acima." />
      ) : (
        <div className="space-y-3">
          {schedules.map((s) => (
            <Card key={s.id}>
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-text">{s.name}</p>
                      {s.isProcessing && <Badge tone="warn">executando</Badge>}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-text-faint">
                      {s.cronMinute} {s.cronHour} {s.cronDayOfMonth} {s.cronMonth} {s.cronDayOfWeek} · {s.timezone}
                      {s.onlyWhenOnline && ' · somente online'}
                    </p>
                    <p className="text-xs text-text-faint">
                      Próxima execução: {formatDate(s.nextRunAt)} · Última: {formatDate(s.lastRunAt)}
                      {s.lastRunStatus && ` (${STATUS_LABELS[s.lastRunStatus] ?? s.lastRunStatus})`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void handleToggleActive(s.id, s.isActive)}>
                      {s.isActive ? 'Ativo' : 'Inativo'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(s.id)}>
                      Excluir
                    </Button>
                  </div>
                </div>

                <div className="mt-4 space-y-1.5 border-t border-border pt-3">
                  {s.tasks.map((t) => (
                    <div key={t.id} className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-1.5 text-sm">
                      <span className="text-text">
                        {t.sequenceNumber}. {TASK_LABELS[t.action]}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => void handleDeleteTask(s.id, t.id)}>
                        Remover
                      </Button>
                    </div>
                  ))}
                  <div className="flex gap-2 pt-1">
                    <Button variant="secondary" size="sm" onClick={() => void handleAddTask(s.id, 'power')}>
                      + Reiniciar
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => void handleAddTask(s.id, 'backup')}>
                      + Backup
                    </Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Excluir agendamento"
        message="Isso remove o agendamento e todas as suas tarefas."
        confirmLabel="Excluir"
        tone="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
