import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addTemplateVariable, createTemplate, createTemplateGroup, listTemplateGroups, listTemplates, removeTemplateVariable } from './admin.api';
import { Button } from '@/ui/primitives/Button';
import { ApiError } from '@/shared/api/client';

function TemplateVariables({ templateId, variables }: { templateId: string; variables: { id: string; name: string; envVariable: string; defaultValue: string | null }[] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [envVariable, setEnvVariable] = useState('');
  const [defaultValue, setDefaultValue] = useState('');

  async function handleAdd() {
    if (!name.trim() || !envVariable.trim()) return;
    await addTemplateVariable(templateId, { name: name.trim(), envVariable: envVariable.trim(), defaultValue: defaultValue.trim() || undefined, isUserViewable: true, isUserEditable: true });
    setName('');
    setEnvVariable('');
    setDefaultValue('');
    void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
  }

  async function handleRemove(variableId: string) {
    await removeTemplateVariable(templateId, variableId);
    void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
  }

  return (
    <div className="mt-2 rounded-md bg-surface-2 p-3">
      <p className="mb-2 text-xs font-medium uppercase text-text-faint">Variáveis</p>
      {variables.map((v) => (
        <div key={v.id} className="flex items-center justify-between py-0.5 font-mono text-xs text-text">
          <span>
            {v.envVariable} = {v.defaultValue ?? '(vazio)'} <span className="text-text-faint">({v.name})</span>
          </span>
          <Button variant="ghost" onClick={() => void handleRemove(v.id)}>
            Remover
          </Button>
        </div>
      ))}
      <div className="mt-2 flex items-end gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome amigável" className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text outline-none focus:border-accent" />
        <input value={envVariable} onChange={(e) => setEnvVariable(e.target.value.toUpperCase())} placeholder="ENV_VAR" className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-text outline-none focus:border-accent" />
        <input value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} placeholder="valor padrão" className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text outline-none focus:border-accent" />
        <Button variant="secondary" onClick={() => void handleAdd()}>
          + Adicionar
        </Button>
      </div>
    </div>
  );
}

export function TemplatesPage() {
  const queryClient = useQueryClient();
  const { data: groups } = useQuery({ queryKey: ['admin', 'template-groups'], queryFn: listTemplateGroups });
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const { data: templates, isLoading, isError } = useQuery({ queryKey: ['admin', 'templates', selectedGroup], queryFn: () => listTemplates(selectedGroup || undefined) });

  const [groupName, setGroupName] = useState('');
  const [tplName, setTplName] = useState('');
  const [author, setAuthor] = useState('');
  const [imageLabel, setImageLabel] = useState('default');
  const [imageRef, setImageRef] = useState('');
  const [startupCommand, setStartupCommand] = useState('');
  const [installScript, setInstallScript] = useState('#!/bin/sh\n');
  const [installImage, setInstallImage] = useState('');
  const [installEntrypoint, setInstallEntrypoint] = useState('sh');
  const [error, setError] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [creatingTemplate, setCreatingTemplate] = useState(false);

  async function handleCreateGroup() {
    if (!groupName.trim()) return;
    setCreatingGroup(true);
    setError(null);
    try {
      const g = await createTemplateGroup({ name: groupName.trim() });
      setGroupName('');
      setSelectedGroup(g.id);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'template-groups'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o grupo.');
    } finally {
      setCreatingGroup(false);
    }
  }

  async function handleCreateTemplate() {
    if (!selectedGroup || !tplName.trim() || !author.trim() || !imageRef.trim() || !startupCommand.trim()) return;
    setCreatingTemplate(true);
    setError(null);
    try {
      await createTemplate({
        groupId: selectedGroup,
        name: tplName.trim(),
        author: author.trim(),
        dockerImages: { [imageLabel.trim() || 'default']: imageRef.trim() },
        startupCommand: startupCommand.trim(),
        installScript,
        installImage: installImage.trim() || undefined,
        installEntrypoint: installEntrypoint.trim() || undefined,
      });
      setTplName('');
      setAuthor('');
      setImageRef('');
      setStartupCommand('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o template.');
    } finally {
      setCreatingTemplate(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="font-medium text-text">Templates (jogos)</h1>

      <div className="flex items-end gap-2 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Grupo (nest)</label>
          <select value={selectedGroup} onChange={(e) => setSelectedGroup(e.target.value)} className="w-56 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent">
            <option value="">Todos os grupos</option>
            {groups?.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Novo grupo</label>
          <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Minecraft" className="w-48 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <Button variant="secondary" disabled={creatingGroup} onClick={() => void handleCreateGroup()}>
          + Criar grupo
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Nome do template</label>
          <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="Paper" className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Autor</label>
          <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="pxhost" className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Rótulo da imagem</label>
          <input value={imageLabel} onChange={(e) => setImageLabel(e.target.value)} className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Imagem Docker</label>
          <input value={imageRef} onChange={(e) => setImageRef(e.target.value)} placeholder="ghcr.io/pxhost/yolks:java_21" className="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="col-span-2 flex flex-col gap-1">
          <label className="text-xs text-text-muted">Comando de inicialização</label>
          <input value={startupCommand} onChange={(e) => setStartupCommand(e.target.value)} placeholder="java -jar server.jar" className="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Imagem de instalação</label>
          <input value={installImage} onChange={(e) => setInstallImage(e.target.value)} placeholder="ghcr.io/pxhost/installers:debian" className="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">Entrypoint de instalação</label>
          <input value={installEntrypoint} onChange={(e) => setInstallEntrypoint(e.target.value)} className="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent" />
        </div>
        <div className="col-span-2 flex flex-col gap-1">
          <label className="text-xs text-text-muted">Script de instalação</label>
          <textarea value={installScript} onChange={(e) => setInstallScript(e.target.value)} rows={6} className="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent" />
        </div>
        <div className="col-span-2">
          <Button variant="primary" disabled={!selectedGroup || creatingTemplate} onClick={() => void handleCreateTemplate()}>
            {creatingTemplate ? 'Criando…' : selectedGroup ? 'Criar template' : 'Selecione um grupo primeiro'}
          </Button>
        </div>
      </div>

      {error && <p className="rounded-md bg-fail-tint px-3 py-2 text-sm text-fail">{error}</p>}

      <div className="min-h-0 flex-1 space-y-3 overflow-auto">
        {isLoading && <p className="text-sm text-text-muted">Carregando…</p>}
        {isError && <p className="text-sm text-fail">Não foi possível carregar os templates.</p>}
        {templates && templates.length === 0 && <p className="text-sm text-text-muted">Nenhum template ainda.</p>}
        {templates?.map((t) => (
          <div key={t.id} className="rounded-lg border border-border bg-surface p-4">
            <p className="font-medium text-text">
              {t.name} <span className="text-xs text-text-faint">por {t.author}</span>
            </p>
            <p className="font-mono text-xs text-text-faint">{Object.values(t.dockerImages).join(', ')}</p>
            <p className="font-mono text-xs text-text-faint">$ {t.startupCommand}</p>
            <TemplateVariables templateId={t.id} variables={t.variables} />
          </div>
        ))}
      </div>
    </div>
  );
}
