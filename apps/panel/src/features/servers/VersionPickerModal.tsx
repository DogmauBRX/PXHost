import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { changeServerVersion, getServerSetup } from './servers.api';
import type { ServerSetupSoftwareOption } from '@/shared/api/types';
import { SoftwareIcon } from '@/features/public/software-icons';
import { ApiError } from '@/shared/api/client';
import { Alert, Badge, Button, Card, ConfirmDialog, LoadingRow, Modal } from '@/ui/primitives';

const CATEGORY_LABELS: Record<string, string> = {
  paper: 'Paper',
  purpur: 'Purpur',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  vanilla: 'Vanilla',
  spigot: 'Spigot',
  bukkit: 'Bukkit',
  bungeecord: 'BungeeCord',
  velocity: 'Velocity',
};

function categoryLabel(kind: string | null): string {
  return (kind && CATEGORY_LABELS[kind]) || 'Outro';
}

// One card per (software, Minecraft version) pair — a curated software
// with 5 versions becomes 5 independently-installable cards, per the
// requested UX. A non-curated software (free-text version, no `in:` rule)
// gets a single card using its own default value ("latest", almost
// always) since there is no fixed list to flatten.
interface VersionCard {
  templateId: string;
  softwareName: string;
  iconUrl: string | null;
  softwareKind: string | null;
  version: string;
}

function flattenToCards(software: ServerSetupSoftwareOption[]): VersionCard[] {
  return software.flatMap((s) => {
    const versions = s.versionsCurated ? s.versions : [s.defaultVersion ?? 'latest'];
    return versions.map((version) => ({
      templateId: s.id,
      softwareName: s.name,
      iconUrl: s.iconUrl,
      softwareKind: s.softwareKind,
      version,
    }));
  });
}

/**
 * "Trocar Versão" — lets the owner of an already-`ready` server reinstall
 * it onto a different software/Minecraft version (Vanilla ⇄ Paper ⇄ Forge
 * ⇄ Fabric, or just a newer build of the same one), from the same curated
 * catalog the post-purchase setup screen already uses
 * (`ServerSetupPage`/`getServerSetup` — see that endpoint's own doc
 * comment for why it works unchanged for a `ready` server too).
 *
 * The caller is responsible for only rendering the trigger button when
 * the server is actually offline — `ServerSetupService.changeVersion`
 * enforces this server-side regardless (409 `SERVER_MUST_BE_OFFLINE`),
 * this component just surfaces that as a plain, unsurprising `ApiError`
 * message if the server started running between the button rendering and
 * the click landing.
 */
export function VersionPickerModal({
  serverId,
  currentTemplateId,
  currentVersion,
  open,
  onClose,
}: {
  serverId: string;
  currentTemplateId: string | null;
  // The server's own current MINECRAFT_VERSION value — needed alongside
  // currentTemplateId because EVERY version of the same software shares
  // one templateId (a curated software with 20 versions flattens into 20
  // cards, per flattenToCards below, all pointing at that one template).
  // Found live: comparing templateId alone marked every card for the
  // customer's current software as "atual" at once, disabling every
  // "Instalar" button for it — not just the one actually installed.
  currentVersion: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: setup, isLoading, isError } = useQuery({
    queryKey: ['server-setup', serverId],
    queryFn: () => getServerSetup(serverId),
    enabled: open,
  });

  const [category, setCategory] = useState<string>('');
  const [pending, setPending] = useState<VersionCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cards = useMemo(() => flattenToCards(setup?.software ?? []), [setup]);
  // No "Todos" tab — found live: with every real version each project
  // ever shipped now curated (KNOWN_MINECRAFT_VERSIONS/live discovery,
  // dozens to 100+ per software), a combined list mixing all of them
  // together stopped being something a customer could actually scan.
  // Always exactly one software's cards showing keeps this a real picker,
  // not an endless scroll.
  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const c of cards) seen.add(categoryLabel(c.softwareKind));
    return Array.from(seen).sort();
  }, [cards]);
  // categories only exists once `cards` (an async query) resolves, so the
  // initial category can't be chosen synchronously at useState time —
  // this picks the first one the moment the real list is known, and
  // re-picks if the current selection ever stops being valid (e.g. this
  // server's own software disappearing from a future catalog).
  useEffect(() => {
    if (categories.length > 0 && !categories.includes(category)) setCategory(categories[0]);
  }, [categories, category]);
  const visibleCards = cards.filter((c) => categoryLabel(c.softwareKind) === category);

  const mutation = useMutation({
    mutationFn: (card: VersionCard) =>
      changeServerVersion(serverId, { templateId: card.templateId, variables: { MINECRAFT_VERSION: card.version } }),
    onSuccess: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
      void queryClient.invalidateQueries({ queryKey: ['server-variables', serverId] });
      onClose();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Não foi possível trocar a versão. Tente novamente.');
    },
  });

  return (
    <>
      <Modal open={open} onClose={onClose} title="Trocar versão do Minecraft" size="lg">
        {error && (
          <Alert className="mb-4" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

        {isLoading ? (
          <LoadingRow label="Carregando versões disponíveis…" />
        ) : isError || !setup ? (
          <Alert tone="fail">Não foi possível carregar as versões disponíveis.</Alert>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-2">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                    category === cat ? 'border-accent-strong bg-accent-tint text-accent-strong' : 'border-border text-text-muted hover:text-text'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {visibleCards.map((card) => {
                const isCurrent = card.templateId === currentTemplateId && card.version === currentVersion;
                return (
                  <Card key={`${card.templateId}-${card.version}`} className={isCurrent ? 'border-brand ring-1 ring-brand' : undefined}>
                    <div className="flex items-center gap-3 p-4">
                      <SoftwareIcon template={{ iconUrl: card.iconUrl, softwareKind: card.softwareKind, name: card.softwareName }} className="h-9 w-9" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-medium text-text">{card.softwareName}</p>
                          {isCurrent && <Badge tone="ok">atual</Badge>}
                        </div>
                        <p className="text-xs text-text-muted">Minecraft {card.version}</p>
                      </div>
                      <Button variant="secondary" size="sm" disabled={isCurrent} onClick={() => setPending(card)}>
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        Instalar
                      </Button>
                    </div>
                  </Card>
                );
              })}
              {visibleCards.length === 0 && <p className="text-sm text-text-muted sm:col-span-2">Nenhuma versão disponível nesta categoria.</p>}
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        title="Trocar versão"
        message={
          pending
            ? `Isso vai instalar ${pending.softwareName} (Minecraft ${pending.version}), sobrescrevendo o server.jar atual. O mundo, plugins e configurações são preservados. O servidor precisa ficar parado durante a instalação.`
            : ''
        }
        confirmLabel={mutation.isPending ? 'Instalando…' : 'Trocar versão'}
        loading={mutation.isPending}
        onConfirm={() => pending && mutation.mutate(pending)}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
