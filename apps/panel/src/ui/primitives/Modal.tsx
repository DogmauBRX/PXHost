import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

type Size = 'sm' | 'md' | 'lg' | 'xl';

const sizeClasses: Record<Size, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: Size;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * Built on the native <dialog> element, which brings focus trapping, Esc to
 * close, inertness of the page behind it and top-layer stacking for free —
 * no dependency and no z-index arithmetic.
 *
 * Worth noting why this exists at all: every destructive confirmation in the
 * panel used to be a `window.confirm()`. Those are auto-dismissed by
 * automated browsers, which is what blocked verifying the token-rotation and
 * suspend flows through the UI in M13/M14. Real dialogs fix the look and the
 * testability in one move.
 */
export function Modal({ open, onClose, title, description, size = 'md', footer, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // Esc fires `cancel`, and the backdrop click below fires `close`; both
  // funnel into onClose so the parent's state stays the source of truth.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      onClick={(e) => {
        // Clicks on the dialog element itself land on the backdrop; anything
        // inside the panel stops at the panel's own handler below.
        if (e.target === ref.current) onClose();
      }}
      // Explicit fixed/inset/margin rather than relying on the UA
      // stylesheet's dialog:modal centering — found live: without it the
      // panel scrolled away with the page instead of staying put in the
      // viewport, once the redesign made the document itself the scroller.
      className={`fixed inset-0 m-auto max-h-[85vh] w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-0 text-text shadow-lg backdrop:bg-black/40 ${sizeClasses[size]}`}
    >
      {/* flex column with a min-h-0 scrolling body — not fixed vh splits
          between header/body/footer, which would overflow the dialog's own
          max-h-[85vh] whenever a title wraps to two lines. */}
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] flex-col">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-text">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-text-muted">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="-m-1 rounded-lg p-1 text-text-faint transition hover:bg-surface-2 hover:text-text"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </dialog>
  );
}
