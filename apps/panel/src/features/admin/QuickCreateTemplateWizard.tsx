import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Search, X } from 'lucide-react';
import { createTemplateFromPreset, discoverSoftwareBuilds, discoverSoftwareVersions } from './admin.api';
import { ApiError } from '@/shared/api/client';
import type { PresetKind } from '@/shared/api/types';
import { Alert, Badge, Button, Card, CardBody, Field, Input, Modal, Toggle } from '@/ui/primitives';

/**
 * The "criação rápida" wizard (Admin Templates redesign) — the primary
 * way an admin adds a template from here on. Deliberately hides
 * everything `CreateTemplateModal` (kept as "Criação avançada") still
 * asks for: Docker image, install script, entrypoint. Those come from
 * `SOFTWARE_PRESETS` server-side (`templates.service.ts`'s
 * `createFromPreset`) — this component only ever collects what the admin
 * actually has an opinion about: which software, which versions/builds
 * are sellable, and the template's name/visibility.
 */

interface PresetCard {
  kind: PresetKind;
  label: string;
  description: string;
  /** Whether this preset has a second version tier (build/loader) at all — Vanilla doesn't, so Etapa 3 is skipped entirely for it. */
  hasBuild: boolean;
  buildLabel: string;
}

const PRESET_CARDS: PresetCard[] = [
  { kind: 'paper', label: 'Paper', description: 'Alto desempenho, compatível com a maioria dos plugins.', hasBuild: true, buildLabel: 'Build do Paper' },
  { kind: 'purpur', label: 'Purpur', description: 'Baseado no Paper, com ajustes extras de performance e gameplay.', hasBuild: true, buildLabel: 'Build do Purpur' },
  { kind: 'vanilla', label: 'Vanilla', description: 'Minecraft oficial, sem plugins nem mods.', hasBuild: false, buildLabel: '' },
  { kind: 'fabric', label: 'Fabric', description: 'Leve e rápido para mods via Fabric Loader.', hasBuild: true, buildLabel: 'Versão do Fabric Loader' },
  { kind: 'quilt', label: 'Quilt', description: 'Loader moderno compatível com a maioria dos mods Fabric.', hasBuild: true, buildLabel: 'Versão do Quilt Loader' },
  { kind: 'forge', label: 'Forge', description: 'O mod loader mais usado por modpacks tradicionais.', hasBuild: true, buildLabel: 'Versão do Forge' },
  { kind: 'neoforge', label: 'NeoForge', description: 'Fork ativamente mantido do Forge para versões modernas.', hasBuild: true, buildLabel: 'Versão do NeoForge' },
];

type Step = 1 | 2 | 3 | 4 | 5;

interface WizardState {
  kind: PresetKind | null;
  minecraftVersions: string[];
  builds: string[];
  name: string;
  description: string;
  groupId: string;
  isPublic: boolean;
  isActive: boolean;
}

const EMPTY_STATE = (groupId: string): WizardState => ({
  kind: null,
  minecraftVersions: [],
  builds: [],
  name: '',
  description: '',
  groupId,
  isPublic: true,
  isActive: true,
});

// ---- Chip editor — shared shape for both the version list (Etapa 2) and the build/loader list (Etapa 3) ----

function ChipEditor({
  placeholder,
  values,
  onChange,
  suggestions,
  loadingSuggestions,
  onSearch,
}: {
  placeholder: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions: string[];
  loadingSuggestions: boolean;
  onSearch?: () => void;
}) {
  const [text, setText] = useState('');

  function add(raw: string) {
    const trimmed = raw.trim();
    if (trimmed && !values.includes(trimmed)) onChange([...values, trimmed]);
    setText('');
  }

  return (
    <div>
      {values.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-1 pr-1.5 pl-2.5 font-mono text-xs text-text">
              {v}
              <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} className="rounded-full p-0.5 text-text-faint hover:bg-surface hover:text-text" aria-label={`Remover ${v}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(text);
            }
          }}
          placeholder={placeholder}
          className="font-mono"
        />
        <Button type="button" variant="secondary" onClick={() => add(text)} disabled={!text.trim()}>
          + Adicionar
        </Button>
        {onSearch && (
          <Button type="button" variant="secondary" onClick={onSearch} disabled={loadingSuggestions}>
            {loadingSuggestions ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Search className="h-4 w-4" aria-hidden="true" />}
            Buscar
          </Button>
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {suggestions
            .filter((s) => !values.includes(s))
            .slice(0, 12)
            .map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => add(s)}
                className="rounded-full border border-border px-2.5 py-1 font-mono text-xs text-text-muted transition hover:border-brand hover:text-text"
              >
                + {s}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// ---- Live summary sidebar — Etapas 2-5 (seção 9 do pedido) ----

function Summary({ state, card }: { state: WizardState; card: PresetCard | undefined }) {
  return (
    <div className="space-y-3 rounded-lg bg-surface-2 p-4 text-sm">
      <p className="text-xs font-semibold tracking-wide text-text-faint uppercase">Resumo</p>
      <p className="text-text-muted">Minecraft</p>
      <p className="font-medium text-text">{card?.label ?? '—'}</p>
      {state.minecraftVersions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {state.minecraftVersions.map((v) => (
            <Badge key={v}>{v}</Badge>
          ))}
        </div>
      )}
      {card?.hasBuild && state.builds.length > 0 && (
        <>
          <p className="text-text-muted">{card.buildLabel}</p>
          <div className="flex flex-wrap gap-1">
            {state.builds.map((b) => (
              <Badge key={b}>{b}</Badge>
            ))}
          </div>
        </>
      )}
      <p className="text-text-muted">Status</p>
      <p className="text-text">
        {state.isActive ? 'Ativo' : 'Inativo'} · {state.isPublic ? 'Público' : 'Não público'}
      </p>
    </div>
  );
}

export function QuickCreateTemplateWizard({
  open,
  onClose,
  defaultGroupId,
  onOpenAdvanced,
}: {
  open: boolean;
  onClose: () => void;
  defaultGroupId: string;
  /** Escape hatch to the old technical form — section "Criação avançada," never removed, just no longer the default door in. */
  onOpenAdvanced: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [state, setState] = useState<WizardState>(EMPTY_STATE(defaultGroupId));
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setStep(1);
      setState(EMPTY_STATE(defaultGroupId));
      setSuggestions([]);
      setError(null);
    }
  }, [open, defaultGroupId]);

  const card = PRESET_CARDS.find((c) => c.kind === state.kind);

  function patch(p: Partial<WizardState>) {
    setState((s) => ({ ...s, ...p }));
  }

  async function searchVersions() {
    if (!state.kind) return;
    setSearching(true);
    setSuggestions(await discoverSoftwareVersions(state.kind));
    setSearching(false);
  }

  async function searchBuilds() {
    if (!state.kind || state.minecraftVersions.length === 0) return;
    setSearching(true);
    setSuggestions(await discoverSoftwareBuilds(state.kind, state.minecraftVersions[0]));
    setSearching(false);
  }

  function goToStep3() {
    setSuggestions([]);
    setStep(card?.hasBuild ? 3 : 4);
  }

  function canProceedFromStep(s: Step): boolean {
    if (s === 1) return state.kind !== null;
    if (s === 2) return state.minecraftVersions.length > 0;
    if (s === 3) return !card?.hasBuild || state.builds.length > 0;
    if (s === 4) return state.name.trim().length > 0 && state.groupId.trim().length > 0;
    return true;
  }

  async function handleSave() {
    if (!state.kind) return;
    setSaving(true);
    setError(null);
    try {
      await createTemplateFromPreset({
        groupId: state.groupId,
        name: state.name.trim(),
        softwareKind: state.kind,
        description: state.description.trim() || undefined,
        minecraftVersions: state.minecraftVersions,
        builds: card?.hasBuild ? state.builds : undefined,
        isPublic: state.isPublic,
        isActive: state.isActive,
      });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o template.');
    } finally {
      setSaving(false);
    }
  }

  const showSidebar = step >= 2;

  return (
    <Modal open={open} onClose={onClose} title="Adicionar template" size={showSidebar ? 'lg' : 'md'}>
      {error && (
        <Alert className="mb-4" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className={showSidebar ? 'grid grid-cols-1 gap-6 sm:grid-cols-[1fr_220px]' : ''}>
        <div className="space-y-4">
          {step === 1 && (
            <fieldset>
              <legend className="mb-3 text-xs font-semibold tracking-wide text-text-faint uppercase">Etapa 1 — Software</legend>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {PRESET_CARDS.map((c) => (
                  <Card
                    key={c.kind}
                    className={`cursor-pointer transition ${state.kind === c.kind ? 'border-brand ring-1 ring-brand' : 'hover:border-text-faint'}`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        patch({ kind: c.kind, minecraftVersions: [], builds: [] });
                        setSuggestions([]);
                        setStep(2);
                      }}
                      className="block w-full p-4 text-left"
                    >
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-text">{c.label}</p>
                        {state.kind === c.kind && <Check className="h-4 w-4 text-brand" aria-hidden="true" />}
                      </div>
                      <p className="mt-1 text-xs text-text-muted">{c.description}</p>
                    </button>
                  </Card>
                ))}
              </div>
              <p className="mt-4 text-xs text-text-faint">
                Precisa configurar imagem Docker, script de instalação ou outro tipo de software?{' '}
                <button type="button" className="text-brand underline" onClick={onOpenAdvanced}>
                  Usar criação avançada
                </button>
                .
              </p>
            </fieldset>
          )}

          {step === 2 && (
            <fieldset>
              <legend className="mb-1 text-xs font-semibold tracking-wide text-text-faint uppercase">Etapa 2 — Versões do Minecraft</legend>
              <p className="mb-3 text-xs text-text-muted">Quais versões do Minecraft o cliente poderá escolher para {card?.label}? Adicione uma ou mais.</p>
              <ChipEditor
                placeholder="ex: 1.21.8"
                values={state.minecraftVersions}
                onChange={(minecraftVersions) => patch({ minecraftVersions })}
                suggestions={suggestions}
                loadingSuggestions={searching}
                onSearch={() => void searchVersions()}
              />
            </fieldset>
          )}

          {step === 3 && card?.hasBuild && (
            <fieldset>
              <legend className="mb-1 text-xs font-semibold tracking-wide text-text-faint uppercase">Etapa 3 — {card.buildLabel}</legend>
              <p className="mb-3 text-xs text-text-muted">
                {state.kind === 'fabric'
                  ? 'Versões do Fabric Loader disponíveis — independem da versão do Minecraft escolhida.'
                  : `Builds de ${card.label} disponíveis para ${state.minecraftVersions[0]}.`}
              </p>
              <ChipEditor
                placeholder="ex: latest"
                values={state.builds}
                onChange={(builds) => patch({ builds })}
                suggestions={suggestions}
                loadingSuggestions={searching}
                onSearch={() => void searchBuilds()}
              />
            </fieldset>
          )}

          {step === 4 && (
            <fieldset className="space-y-4">
              <legend className="mb-1 text-xs font-semibold tracking-wide text-text-faint uppercase">Etapa 4 — Nome e visibilidade</legend>
              <Field label="Nome do template" htmlFor="wiz-name" required>
                <Input id="wiz-name" value={state.name} onChange={(e) => patch({ name: e.target.value })} placeholder={card?.label} />
              </Field>
              <Field label="Descrição" htmlFor="wiz-description">
                <Input id="wiz-description" value={state.description} onChange={(e) => patch({ description: e.target.value })} placeholder={card?.description} />
              </Field>
              <div className="flex flex-wrap gap-6">
                <Toggle id="wiz-active" checked={state.isActive} onChange={(checked) => patch({ isActive: checked })} label="Ativo" />
                <Toggle id="wiz-public" checked={state.isPublic} onChange={(checked) => patch({ isPublic: checked })} label="Público (aparece no checkout)" />
              </div>
            </fieldset>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <p className="text-xs font-semibold tracking-wide text-text-faint uppercase">Etapa 5 — Revisão</p>
              <Card>
                <CardBody className="space-y-2 text-sm">
                  <p className="font-medium text-text">{state.name}</p>
                  {state.description && <p className="text-text-muted">{state.description}</p>}
                  <p>
                    <span className="text-text-muted">Software: </span>
                    {card?.label}
                  </p>
                  <p>
                    <span className="text-text-muted">Minecraft: </span>
                    {state.minecraftVersions.join(', ')}
                  </p>
                  {card?.hasBuild && (
                    <p>
                      <span className="text-text-muted">{card.buildLabel}: </span>
                      {state.builds.join(', ')}
                    </p>
                  )}
                  <p>
                    <span className="text-text-muted">Status: </span>
                    {state.isActive ? 'Ativo' : 'Inativo'} · {state.isPublic ? 'Público' : 'Não público'}
                  </p>
                </CardBody>
              </Card>
            </div>
          )}
        </div>

        {showSidebar && <Summary state={state} card={card} />}
      </div>

      <div className="mt-6 flex justify-between gap-2 border-t border-border pt-4">
        <Button variant="secondary" onClick={() => (step === 1 ? onClose() : setStep((s) => (s - 1) as Step))}>
          {step === 1 ? 'Cancelar' : 'Voltar'}
        </Button>
        {step < 5 ? (
          <Button variant="primary" disabled={!canProceedFromStep(step)} onClick={() => (step === 2 ? goToStep3() : setStep((s) => (s + 1) as Step))}>
            Continuar
          </Button>
        ) : (
          <Button variant="primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? 'Salvando…' : 'Salvar template'}
          </Button>
        )}
      </div>
    </Modal>
  );
}
