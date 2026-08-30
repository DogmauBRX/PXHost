import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Input } from './Input';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  loading?: boolean;
  /**
   * When set, the confirm button stays disabled until the user types this
   * exact string — the pattern the backups page already used for restores,
   * now available to any irreversible action.
   */
  confirmPhrase?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'default',
  loading = false,
  confirmPhrase,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const blocked = confirmPhrase ? typed.trim() !== confirmPhrase : false;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={loading || blocked}
          >
            {loading ? 'Aguarde…' : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-muted">{message}</p>
      {confirmPhrase && (
        <div className="mt-4 flex flex-col gap-1.5">
          <label htmlFor="confirm-phrase" className="text-sm text-text">
            Digite <span className="font-mono font-semibold text-text">{confirmPhrase}</span> para confirmar
          </label>
          <Input
            id="confirm-phrase"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
    </Modal>
  );
}
