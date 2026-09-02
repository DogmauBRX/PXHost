import { useEffect, useRef, useState } from 'react';
import { Bot, X } from 'lucide-react';
import { AssistantChat } from './AssistantChat';

/**
 * Floating button + slide-over panel, mounted on every server page
 * (client.servers.$serverId.tsx). A panel, not a tab — the value is
 * asking about the page you're already on without navigating away from
 * it (Fase 8/9 design). Built on the native <dialog> for the same
 * focus-trap/Esc/top-layer benefits Modal.tsx uses, just docked to the
 * right edge instead of centered.
 */
export function AssistantDrawer({ serverId }: { serverId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      setOpen(false);
    };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-6 bottom-6 z-40 flex items-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-accent-strong"
      >
        <Bot className="h-4 w-4" aria-hidden="true" />
        Assistente PXHOST
      </button>

      <dialog
        ref={ref}
        onClick={(e) => {
          if (e.target === ref.current) setOpen(false);
        }}
        // `left-auto` overrides the UA dialog:modal default of `inset: 0`
        // (which otherwise pins `left: 0` too) — without it, `right-0`
        // loses to that left anchor once width is constrained by
        // max-w-sm instead of stretching to fill both edges, and the
        // panel renders flush-left instead of docked to the right.
        className="fixed inset-y-0 right-0 left-auto m-0 h-full w-full max-w-sm rounded-l-2xl border-l border-border bg-surface p-0 text-text shadow-2xl backdrop:bg-black/30"
      >
        {/* `flex` lives here, not on the <dialog> itself — a display override
            on the dialog element defeats the UA stylesheet's own
            `dialog:not([open]) { display: none }`, which is what made this
            panel render (and eat clicks) even while closed. Modal.tsx
            avoids the same trap the same way. */}
        <div onClick={(e) => e.stopPropagation()} className="flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3.5">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-tint text-accent-strong">
                <Bot className="h-4 w-4" aria-hidden="true" />
              </span>
              <h2 className="text-sm font-semibold text-text">Assistente PXHOST</h2>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Fechar"
              className="-m-1 rounded-lg p-1 text-text-faint transition hover:bg-surface-2 hover:text-text"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 px-4 py-3">
            <AssistantChat serverId={serverId} />
          </div>
        </div>
      </dialog>
    </>
  );
}
