import { Loader2 } from 'lucide-react';

/**
 * Shown while a server sits at `status: 'installing'` — there is no
 * running container yet (the agent is mid-download/mid-install), so none
 * of the normal tabs (Console, Arquivos, Backups, ...) would have
 * anything real to show. All the polling logic lives in `ServerLayout`
 * (the parent route), which re-fetches the server every few seconds and
 * swaps this page out for the normal tabbed view the moment `status`
 * moves on to `ready` or `install_failed` — this component itself is
 * pure presentation, no query of its own.
 */
export function ServerInstallingPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-20 text-center">
      <Loader2 className="h-10 w-10 animate-spin text-accent-strong" aria-hidden="true" />
      <div>
        <h1 className="text-lg font-semibold text-text">Preparando seu servidor…</h1>
        <p className="mt-2 text-sm text-text-muted">
          Estamos baixando e instalando o software escolhido. Isso costuma levar de alguns segundos a alguns minutos, dependendo da versão.
        </p>
      </div>
    </div>
  );
}
