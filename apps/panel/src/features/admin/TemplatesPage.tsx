import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Package, Plus, RefreshCw, Search } from 'lucide-react';
import {
  addTemplateVariable,
  createTemplate,
  createTemplateGroup,
  duplicateTemplate,
  listTemplateGroups,
  listTemplates,
  refreshTemplateVersions,
  removeTemplate,
  removeTemplateVariable,
  updateTemplate,
  updateTemplateVariable,
} from './admin.api';
import { QuickCreateTemplateWizard } from './QuickCreateTemplateWizard';
import { ApiError } from '@/shared/api/client';
import type { AdminTemplate, AdminTemplateVariable, SoftwareKind } from '@/shared/api/types';

const SOFTWARE_OPTIONS: { value: SoftwareKind; label: string }[] = [
  { value: 'paper', label: 'Paper' },
  { value: 'purpur', label: 'Purpur' },
  { value: 'spigot', label: 'Spigot' },
  { value: 'bukkit', label: 'Bukkit' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'vanilla', label: 'Vanilla' },
  { value: 'bungeecord', label: 'BungeeCord' },
  { value: 'velocity', label: 'Velocity' },
  { value: 'other', label: 'Outro' },
];
const SOFTWARE_LABEL: Record<SoftwareKind, string> = Object.fromEntries(SOFTWARE_OPTIONS.map((o) => [o.value, o.label])) as Record<SoftwareKind, string>;
import {
  Alert,
  Badge,
  Button,
  CodeEditor,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  LoadingRow,
  Modal,
  PageHeader,
  PromptDialog,
  Select,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  Toggle,
  TR,
} from '@/ui/primitives';

// ---- One variable's inline edit form — rules/description/viewable/editable/order weren't reachable from the panel at all before (only add/remove existed); this is what lets an admin restrict e.g. MINECRAFT_VERSION to `required|string|in:1.21.1,1.20.6` without touching the database directly. ----

function EditVariableRow({
  templateId,
  variable,
  onDone,
}: {
  templateId: string;
  variable: AdminTemplateVariable;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(variable.name);
  const [description, setDescription] = useState(variable.description ?? '');
  const [defaultValue, setDefaultValue] = useState(variable.defaultValue ?? '');
  const [rules, setRules] = useState(variable.rules ?? 'nullable|string');
  const [isUserViewable, setIsUserViewable] = useState(variable.isUserViewable);
  const [isUserEditable, setIsUserEditable] = useState(variable.isUserEditable);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await updateTemplateVariable(templateId, variable.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        defaultValue,
        rules: rules.trim() || 'nullable|string',
        isUserViewable,
        isUserEditable,
      });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar a variável.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-2 space-y-2 rounded-lg border border-border bg-surface p-3">
      {error && <p className="text-xs text-fail">{error}</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Nome amigável" htmlFor={`v-name-${variable.id}`}>
          <Input id={`v-name-${variable.id}`} value={name} onChange={(e) => setName(e.target.value)} className="text-xs" />
        </Field>
        <Field label="Valor padrão" htmlFor={`v-default-${variable.id}`}>
          <Input id={`v-default-${variable.id}`} value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} className="font-mono text-xs" />
        </Field>
        <Field label="Descrição" htmlFor={`v-desc-${variable.id}`} className="sm:col-span-2">
          <Input id={`v-desc-${variable.id}`} value={description} onChange={(e) => setDescription(e.target.value)} className="text-xs" />
        </Field>
        <Field
          label="Regras"
          htmlFor={`v-rules-${variable.id}`}
          hint="Formato Laravel: required|string|max:16 ou required|integer|min:512 ou required|in:1.21.1,1.20.6 — o mesmo que valida no checkout e ao editar o servidor."
          className="sm:col-span-2"
        >
          <Input id={`v-rules-${variable.id}`} value={rules} onChange={(e) => setRules(e.target.value)} placeholder="nullable|string" className="font-mono text-xs" />
        </Field>
      </div>
      <div className="flex flex-wrap gap-6">
        <Toggle id={`v-viewable-${variable.id}`} checked={isUserViewable} onChange={setIsUserViewable} label="Visível ao cliente" />
        <Toggle id={`v-editable-${variable.id}`} checked={isUserEditable} onChange={setIsUserEditable} label="Editável pelo cliente" />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onDone}>
          Cancelar
        </Button>
        <Button variant="primary" size="sm" disabled={saving || !name.trim()} onClick={() => void handleSave()}>
          {saving ? 'Salvando…' : 'Salvar'}
        </Button>
      </div>
    </div>
  );
}

// ---- Variables sub-panel ----

function TemplateVariables({ templateId, variables }: { templateId: string; variables: AdminTemplateVariable[] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [envVariable, setEnvVariable] = useState('');
  const [defaultValue, setDefaultValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

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
          {variables.map((v) =>
            editingId === v.id ? (
              <EditVariableRow key={v.id} templateId={templateId} variable={v} onDone={() => setEditingId(null)} />
            ) : (
              <div key={v.id} className="flex items-center justify-between gap-2 py-0.5 font-mono text-xs text-text">
                <span className="truncate">
                  {v.envVariable} = {v.defaultValue ?? '(vazio)'} <span className="text-text-faint">({v.name})</span>
                  {!v.isUserViewable && <span className="ml-2 font-sans text-text-faint">oculta</span>}
                  {!v.isUserEditable && <span className="ml-2 font-sans text-text-faint">não editável</span>}
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditingId(v.id)}>
                    Editar
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void handleRemove(v.id)}>
                    Remover
                  </Button>
                </span>
              </div>
            ),
          )}
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
  softwareKind: SoftwareKind | '';
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
  softwareKind: '',
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
    softwareKind: t.softwareKind ?? '',
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
            <Input id="tpl-author" value={values.author} onChange={(e) => onChange({ author: e.target.value })} placeholder="gxhost" />
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
          <Field label="Software" htmlFor="tpl-software" hint="Determina se o cliente vê a aba de Mods ou de Plugins, e onde o assistente diz para colocar os arquivos.">
            <Select id="tpl-software" value={values.softwareKind} onChange={(e) => onChange({ softwareKind: e.target.value as SoftwareKind | '' })}>
              <option value="">— não definido —</option>
              {SOFTWARE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
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
              placeholder="ghcr.io/pterodactyl/yolks:java_21"
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
              placeholder="ghcr.io/parkervcp/installers:debian"
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
        softwareKind: values.softwareKind || undefined,
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
        softwareKind: values.softwareKind || undefined,
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
      {/* Moved here from the page's own template card (Admin Templates
          redesign) — the list is a table now, with no room left for an
          always-expanded variables panel per row. Editing a variable's
          `rules` here (e.g. MINECRAFT_VERSION's `in:` list) is also how
          an admin adjusts version curation for a template the wizard
          created, since the wizard itself is create-only. */}
      {template && <TemplateVariables templateId={template.id} variables={template.variables} />}
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

/** The `MINECRAFT_VERSION` variable's `in:` allow-list, formatted for the table's "Versões" column — mirrors `PublicTemplatesService.deriveOptionShape`'s own `in:` parsing on the backend, read-only here (editing happens in the variable editor inside "Editar"). Falls back to the variable's own default (e.g. "latest") when no curated list was ever set — a template hand-edited before the wizard existed, or the advanced form. */
function templateVersions(t: AdminTemplate): string[] {
  const versionVar = t.variables.find((v) => v.envVariable === 'MINECRAFT_VERSION');
  if (!versionVar) return [];
  const match = /in:([^|]*)/.exec(versionVar.rules ?? '');
  if (match) return match[1].split(',').map((v) => v.trim()).filter(Boolean);
  return versionVar.defaultValue ? [versionVar.defaultValue] : [];
}

export function TemplatesPage() {
  const queryClient = useQueryClient();
  const { data: groups } = useQuery({ queryKey: ['admin', 'template-groups'], queryFn: listTemplateGroups });
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const { data: templates, isLoading, isError } = useQuery({
    queryKey: ['admin', 'templates', selectedGroup],
    queryFn: () => listTemplates(selectedGroup || undefined),
  });

  const [search, setSearch] = useState('');
  const [softwareFilter, setSoftwareFilter] = useState<SoftwareKind | ''>('');
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'inactive'>('');
  const [groupName, setGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [duplicateTarget, setDuplicateTarget] = useState<AdminTemplate | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
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

  async function handleDuplicate(name: string) {
    if (!duplicateTarget) return;
    setDuplicating(true);
    setDuplicateError(null);
    try {
      const copy = await duplicateTemplate(duplicateTarget.id, name);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
      setDuplicateTarget(null);
      setEditingId(copy.id); // falls straight into editing the copy — it needs at least a look before going public
    } catch (err) {
      setDuplicateError(err instanceof ApiError ? err.message : 'Não foi possível duplicar o template.');
    } finally {
      setDuplicating(false);
    }
  }

  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  async function handleRefreshVersions(t: AdminTemplate) {
    setRefreshingId(t.id);
    setRefreshError(null);
    try {
      await refreshTemplateVersions(t.id);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    } catch (err) {
      setRefreshError(err instanceof ApiError ? err.message : `Não foi possível atualizar as versões de "${t.name}".`);
    } finally {
      setRefreshingId(null);
    }
  }

  const [toggleError, setToggleError] = useState<string | null>(null);
  async function handleToggle(t: AdminTemplate, patch: { isActive?: boolean; isPublic?: boolean }) {
    setToggleError(null);
    try {
      await updateTemplate(t.id, patch);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    } catch (err) {
      setToggleError(err instanceof ApiError ? err.message : 'Não foi possível atualizar o template.');
    }
  }

  const groupNameById = new Map((groups ?? []).map((g) => [g.id, g.name]));
  // `editingId` (not the row object itself) is what EditTemplateModal is fed
  // — looked up fresh from the query result on every render, so an edit
  // made INSIDE that modal (a variable add/remove, which invalidates this
  // same query) is reflected the moment the refetch lands, never a stale
  // snapshot taken when "Editar" was first clicked.
  const editingTemplate = templates?.find((t) => t.id === editingId) ?? null;
  const visible = (templates ?? []).filter((t) => {
    if (softwareFilter && t.softwareKind !== softwareFilter) return false;
    if (statusFilter === 'active' && !t.isActive) return false;
    if (statusFilter === 'inactive' && t.isActive) return false;
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
          <Button variant="primary" onClick={() => setWizardOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Adicionar template
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
        <div className="w-40">
          <Select value={softwareFilter} onChange={(e) => setSoftwareFilter(e.target.value as SoftwareKind | '')} aria-label="Filtrar por tipo">
            <option value="">Todos os tipos</option>
            {SOFTWARE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-36">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | 'active' | 'inactive')} aria-label="Filtrar por status">
            <option value="">Todos os status</option>
            <option value="active">Ativo</option>
            <option value="inactive">Inativo</option>
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
      {duplicateError && <Alert className="mb-6">{duplicateError}</Alert>}
      {toggleError && <Alert className="mb-6">{toggleError}</Alert>}
      {refreshError && <Alert className="mb-6" onDismiss={() => setRefreshError(null)}>{refreshError}</Alert>}
      {isError && <Alert className="mb-6">Não foi possível carregar os templates.</Alert>}

      {isLoading ? (
        <LoadingRow />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Nenhum template encontrado"
          description={search || selectedGroup || softwareFilter || statusFilter ? 'Ajuste os filtros ou adicione um novo template.' : 'Adicione o primeiro acima.'}
          action={
            <Button variant="primary" onClick={() => setWizardOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Adicionar template
            </Button>
          }
        />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Template</TH>
                <TH>Jogo</TH>
                <TH>Tipo</TH>
                <TH>Versões</TH>
                <TH>Status</TH>
                <TH>Criado em</TH>
                <TH className="text-right">Ações</TH>
              </TR>
            </THead>
            <TBody>
              {visible.map((t) => {
                const versions = templateVersions(t);
                return (
                  <TR key={t.id}>
                    <TD>
                      <p className="font-medium text-text">{t.name}</p>
                      <p className="text-xs text-text-faint">por {t.author}</p>
                    </TD>
                    <TD className="text-text-muted">{groupNameById.get(t.groupId) ?? '—'}</TD>
                    <TD>
                      {t.softwareKind ? <Badge tone="ok">{SOFTWARE_LABEL[t.softwareKind]}</Badge> : <Badge tone="warn">não definido</Badge>}
                    </TD>
                    <TD>
                      <div className="flex max-w-[220px] flex-wrap items-center gap-1">
                        {versions.length > 0 ? (
                          versions.map((v) => <Badge key={v}>{v}</Badge>)
                        ) : (
                          <span className="text-xs text-text-faint">Texto livre</span>
                        )}
                        {t.softwareKind && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={refreshingId === t.id}
                            onClick={() => void handleRefreshVersions(t)}
                            title="Buscar versões reais disponíveis"
                          >
                            <RefreshCw className={`h-3.5 w-3.5 ${refreshingId === t.id ? 'animate-spin' : ''}`} aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </TD>
                    <TD>
                      <div className="flex flex-col gap-1">
                        <Toggle id={`t-active-${t.id}`} checked={t.isActive} onChange={(checked) => void handleToggle(t, { isActive: checked })} label="Ativo" />
                        <Toggle id={`t-public-${t.id}`} checked={t.isPublic} onChange={(checked) => void handleToggle(t, { isPublic: checked })} label="Público" />
                      </div>
                    </TD>
                    <TD className="text-text-muted">{new Date(t.createdAt).toLocaleDateString('pt-BR')}</TD>
                    <TD>
                      <div className="flex justify-end gap-1">
                        <Button variant="secondary" size="sm" onClick={() => setEditingId(t.id)}>
                          Editar
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDuplicateTarget(t)} title="Duplicar">
                          <Copy className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(t)}>
                          Excluir
                        </Button>
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableWrap>
      )}

      <QuickCreateTemplateWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        defaultGroupId={selectedGroup}
        onOpenAdvanced={() => {
          setWizardOpen(false);
          setCreateOpen(true);
        }}
      />
      <CreateTemplateModal open={createOpen} onClose={() => setCreateOpen(false)} groups={groups} defaultGroupId={selectedGroup} />
      <EditTemplateModal template={editingTemplate} onClose={() => setEditingId(null)} groups={groups} />

      <PromptDialog
        open={duplicateTarget !== null}
        title="Duplicar template"
        label="Nome do novo template"
        hint="Cria uma cópia completa (imagem, script, variáveis) com este nome — a cópia começa não pública até você revisá-la."
        defaultValue={duplicateTarget ? `${duplicateTarget.name} (cópia)` : ''}
        confirmLabel="Duplicar"
        loading={duplicating}
        onSubmit={(name) => void handleDuplicate(name)}
        onCancel={() => setDuplicateTarget(null)}
      />

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
