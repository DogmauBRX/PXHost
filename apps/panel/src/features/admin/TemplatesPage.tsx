import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Package, Plus, Search } from 'lucide-react';
import {
  addTemplateVariable,
  createTemplate,
  createTemplateGroup,
  listTemplateGroups,
  listTemplates,
  removeTemplate,
  removeTemplateVariable,
  updateTemplate,
} from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { AdminTemplate, AdminTemplateVariable } from '@/shared/api/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CodeEditor,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  LoadingRow,
  Modal,
  PageHeader,
  Select,
} from '@/ui/primitives';

// ---- Variables sub-panel — unchanged behavior, restyled ----

function TemplateVariables({ templateId, variables }: { templateId: string; variables: AdminTemplateVariable[] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [envVariable, setEnvVariable] = useState('');
  const [defaultValue, setDefaultValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    if (!name.trim() || !envVariable.trim()) return;
    setError(null);
    try {
      await addTemplateVariable(templateId, {
        name: name.trim(),
        envVariable: envVariable.trim(),
        defaultValue: defaultValue.trim() || undefined,
        isUserViewable: true,
        isUserEditable: true,
      });
      setName('');
      setEnvVariable('');
      setDefaultValue('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível adicionar a variável.');
    }
  }

  async function handleRemove(variableId: string) {
    setError(null);
    try {
      await removeTemplateVariable(templateId, variableId);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível remover a variável.');
    }
  }

  return (
    <div className="mt-4 rounded-lg bg-surface-2 p-3">
      <p className="mb-2 text-xs font-semibold tracking-wide text-text-faint uppercase">Variáveis</p>
      {variables.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {variables.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-2 py-0.5 font-mono text-xs text-text">
              <span className="truncate">
                {v.envVariable} = {v.defaultValue ?? '(vazio)'} <span className="text-text-faint">({v.name})</span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => void handleRemove(v.id)}>
                Remover
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="mb-2 text-xs text-fail">{error}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome amigável" className="w-32 text-xs" />
        {/* Uppercased as the user types — ENV_VAR is the only valid shape here. */}
        <Input
          value={envVariable}
          onChange={(e) => setEnvVariable(e.target.value.toUpperCase())}
          placeholder="ENV_VAR"
          className="w-32 font-mono text-xs"
        />
        <Input value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} placeholder="valor padrão" className="w-32 text-xs" />
        <Button variant="secondary" size="sm" onClick={() => void handleAdd()}>
          + Adicionar
        </Button>
      </div>
    </div>
  );
}

// ---- Create / edit form — shared shape, split into the sections the redesign asked for ----

interface TemplateFormValues {
  groupId: string;
  name: string;
  author: string;
  description: string;
  imageLabel: string;
  imageRef: string;
  startupCommand: string;
  stopCommand: string;
  installImage: string;
  installEntrypoint: string;
  installScript: string;
}

const EMPTY_FORM: TemplateFormValues = {
  groupId: '',
  name: '',
  author: '',
  description: '',
  imageLabel: 'default',
  imageRef: '',
  startupCommand: '',
  stopCommand: '',
  installImage: '',
  installEntrypoint: 'sh',
  installScript: '#!/bin/sh\n',
};

function templateToForm(t: AdminTemplate): TemplateFormValues {
  const [imageLabel, imageRef] = Object.entries(t.dockerImages)[0] ?? ['default', ''];
  return {
    groupId: t.groupId,
    name: t.name,
    author: t.author,
    description: t.description ?? '',
    imageLabel,
    imageRef,
    startupCommand: t.startupCommand,
    stopCommand: t.stopCommand ?? '',
    installImage: t.installImage ?? '',
    installEntrypoint: t.installEntrypoint ?? '',
    installScript: t.installScript,
  };
}

function TemplateFormFields({
  values,
  onChange,
  groups,
}: {
  values: TemplateFormValues;
  onChange: (patch: Partial<TemplateFormValues>) => void;
  groups: { id: string; name: string }[] | undefined;
}) {
  return (
    <div className="space-y-6">
      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Informações gerais</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Nome do template" htmlFor="tpl-name" required>
            <Input id="tpl-name" value={values.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Paper" />
          </Field>
          <Field label="Autor" htmlFor="tpl-author" required>
            <Input id="tpl-author" value={values.author} onChange={(e) => onChange({ author: e.target.value })} placeholder="pxhost" />
          </Field>
          <Field label="Grupo" htmlFor="tpl-group" required>
            <Select id="tpl-group" value={values.groupId} onChange={(e) => onChange({ groupId: e.target.value })}>
              <option value="">Selecione…</option>
              {groups?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Descrição" htmlFor="tpl-description">
            <Input id="tpl-description" value={values.description} onChange={(e) => onChange({ description: e.target.value })} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Docker</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Rótulo da imagem" htmlFor="tpl-image-label">
            <Input id="tpl-image-label" value={values.imageLabel} onChange={(e) => onChange({ imageLabel: e.target.value })} />
          </Field>
          <Field label="Imagem Docker" htmlFor="tpl-image-ref" required>
            <Input
              id="tpl-image-ref"
              value={values.imageRef}
              onChange={(e) => onChange({ imageRef: e.target.value })}
              placeholder="ghcr.io/pxhost/yolks:java_21"
              className="font-mono"
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Inicialização</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Comando de inicialização" htmlFor="tpl-startup" required>
            <Input
              id="tpl-startup"
              value={values.startupCommand}
              onChange={(e) => onChange({ startupCommand: e.target.value })}
              placeholder="java -jar server.jar"
              className="font-mono"
            />
          </Field>
          <Field label="Comando de parada" htmlFor="tpl-stop" hint="Enviado ao console antes de um SIGTERM.">
            <Input id="tpl-stop" value={values.stopCommand} onChange={(e) => onChange({ stopCommand: e.target.value })} className="font-mono" />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold tracking-wide text-text-faint uppercase">Script de instalação</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Imagem de instalação" htmlFor="tpl-install-image">
            <Input
              id="tpl-install-image"
              value={values.installImage}
              onChange={(e) => onChange({ installImage: e.target.value })}
              placeholder="ghcr.io/pxhost/installers:debian"
              className="font-mono"
            />
          </Field>
          <Field label="Entrypoint de instalação" htmlFor="tpl-install-entrypoint">
            <Input
              id="tpl-install-entrypoint"
              value={values.installEntrypoint}
              onChange={(e) => onChange({ installEntrypoint: e.target.value })}
              className="font-mono"
            />
          </Field>
        </div>
        <CodeEditor
          id="tpl-install-script"
          value={values.installScript}
          onChange={(v) => onChange({ installScript: v })}
          language="sh"
        />
      </fieldset>
    </div>
  );
}

function isFormValid(v: TemplateFormValues): boolean {
  return Boolean(v.groupId && v.name.trim() && v.author.trim() && v.imageRef.trim() && v.startupCommand.trim());
}

// ---- Create modal ----

function CreateTemplateModal({
  open,
  onClose,
  groups,
  defaultGroupId,
}: {
  open: boolean;
  onClose: () => void;
  groups: { id: string; name: string }[] | undefined;
  defaultGroupId: string;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<TemplateFormValues>({ ...EMPTY_FORM, groupId: defaultGroupId });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) setValues((v) => ({ ...v, groupId: v.groupId || defaultGroupId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function patch(p: Partial<TemplateFormValues>) {
    setValues((v) => ({ ...v, ...p }));
    setSuccess(false);
  }

  async function handleCreate() {
    if (!isFormValid(values)) return;
    setCreating(true);
    setError(null);
    try {
      await createTemplate({
        groupId: values.groupId,
        name: values.name.trim(),
        author: values.author.trim(),
        description: values.description.trim() || undefined,
        dockerImages: { [values.imageLabel.trim() || 'default']: values.imageRef.trim() },
        startupCommand: values.startupCommand.trim(),
        stopCommand: values.stopCommand.trim() || undefined,
        // Sent untrimmed: a shell script's shebang and trailing newline matter.
        installScript: values.installScript,
        installImage: values.installImage.trim() || undefined,
        installEntrypoint: values.installEntrypoint.trim() || undefined,
      });
      // Keeps image/install config, clears the rest — lets an operator create
      // several templates against the same base image back to back.
      setValues((v) => ({ ...v, name: '', author: '', description: '', startupCommand: '', stopCommand: '' }));
      setSuccess(true);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o template.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Novo template" size="xl">
      {error && (
        <Alert className="mb-4" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert tone="ok" className="mb-4" onDismiss={() => setSuccess(false)}>
          Template criado. Os campos de imagem e script continuam preenchidos para criar outro parecido.
        </Alert>
      )}
      <TemplateFormFields values={values} onChange={patch} groups={groups} />
      <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
        <Button variant="secondary" onClick={onClose}>
          Fechar
        </Button>
        <Button variant="primary" disabled={!isFormValid(values) || creating} onClick={() => void handleCreate()}>
          {creating ? 'Criando…' : 'Criar template'}
        </Button>
      </div>
    </Modal>
  );
}

// ---- Edit modal ----

function EditTemplateModal({
  template,
  onClose,
  groups,
}: {
  template: AdminTemplate | null;
  onClose: () => void;
  groups: { id: string; name: string }[] | undefined;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<TemplateFormValues>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (template) setValues(templateToForm(template));
  }, [template]);

  async function handleSave() {
    if (!template || !isFormValid(values)) return;
    setSaving(true);
    setError(null);
    try {
      await updateTemplate(template.id, {
        groupId: values.groupId,
        name: values.name.trim(),
        author: values.author.trim(),
        description: values.description.trim(),
        dockerImages: { [values.imageLabel.trim() || 'default']: values.imageRef.trim() },
        startupCommand: values.startupCommand.trim(),
        stopCommand: values.stopCommand.trim(),
        installImage: values.installImage.trim(),
        installEntrypoint: values.installEntrypoint.trim(),
        installScript: values.installScript,
      });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o template.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={template !== null} onClose={onClose} title={template ? `Editar “${template.name}”` : ''} size="xl">
      {error && (
        <Alert className="mb-4" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      <TemplateFormFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} groups={groups} />
      <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" disabled={!isFormValid(values) || saving} onClick={() => void handleSave()}>
          {saving ? 'Salvando…' : 'Salvar alterações'}
        </Button>
      </div>
    </Modal>
  );
}

// ---- Page ----

export function TemplatesPage() {
  const queryClient = useQueryClient();
  const { data: groups } = useQuery({ queryKey: ['admin', 'template-groups'], queryFn: listTemplateGroups });
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const { data: templates, isLoading, isError } = useQuery({
    queryKey: ['admin', 'templates', selectedGroup],
    queryFn: () => listTemplates(selectedGroup || undefined),
  });

  const [search, setSearch] = useState('');
  const [groupName, setGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AdminTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminTemplate | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleCreateGroup() {
    if (!groupName.trim()) return;
    setCreatingGroup(true);
    setGroupError(null);
    try {
      const g = await createTemplateGroup({ name: groupName.trim() });
      setGroupName('');
      setSelectedGroup(g.id);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'template-groups'] });
    } catch (err) {
      setGroupError(err instanceof ApiError ? err.message : 'Não foi possível criar o grupo.');
    } finally {
      setCreatingGroup(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await removeTemplate(deleteTarget.id);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Não foi possível excluir o template.');
    } finally {
      setDeleteTarget(null);
    }
  }

  const groupNameById = new Map((groups ?? []).map((g) => [g.id, g.name]));
  const visible = (templates ?? []).filter((t) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return t.name.toLowerCase().includes(q) || t.author.toLowerCase().includes(q);
  });

  return (
    <>
      <PageHeader
        title="Templates"
        subtitle="Gerencie os templates utilizados pelos seus servidores."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo Template
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Select value={selectedGroup} onChange={(e) => setSelectedGroup(e.target.value)} aria-label="Filtrar por grupo">
            <option value="">Todos os grupos</option>
            {groups?.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-faint" aria-hidden="true" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Pesquisar template…" className="pl-9" />
        </div>
        <div className="flex items-end gap-2">
          <Field label="Novo grupo" htmlFor="new-group" className="w-40">
            <Input id="new-group" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Minecraft" />
          </Field>
          <Button variant="secondary" disabled={creatingGroup || !groupName.trim()} onClick={() => void handleCreateGroup()}>
            + Criar grupo
          </Button>
        </div>
      </div>

      {groupError && <Alert className="mb-6">{groupError}</Alert>}
      {deleteError && <Alert className="mb-6">{deleteError}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os templates.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Nenhum template encontrado"
          description={search || selectedGroup ? 'Ajuste os filtros ou crie um novo template.' : 'Crie o primeiro acima.'}
          action={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Novo Template
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {visible.map((t) => (
            <Card key={t.id}>
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-text">{t.name}</p>
                      <span className="text-xs text-text-faint">por {t.author}</span>
                      {groupNameById.get(t.groupId) && <Badge>{groupNameById.get(t.groupId)}</Badge>}
                      {!t.isActive && <Badge tone="neutral">inativo</Badge>}
                    </div>
                    <p className="mt-1 font-mono text-xs text-text-faint">{Object.values(t.dockerImages).join(', ')}</p>
                    <p className="font-mono text-xs text-text-faint">$ {t.startupCommand}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setEditing(t)}>
                      Editar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(t)}>
                      Excluir
                    </Button>
                  </div>
                </div>
                <TemplateVariables templateId={t.id} variables={t.variables} />
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <CreateTemplateModal open={createOpen} onClose={() => setCreateOpen(false)} groups={groups} defaultGroupId={selectedGroup} />
      <EditTemplateModal template={editing} onClose={() => setEditing(null)} groups={groups} />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Excluir template"
        message={`Excluir "${deleteTarget?.name}"? Esta ação não pode ser desfeita. Templates em uso por servidores não podem ser excluídos.`}
        confirmLabel="Excluir"
        tone="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
