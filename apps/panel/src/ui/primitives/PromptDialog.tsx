import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Input } from './Input';
import { Field } from './Field';

interface PromptDialogProps {
  open: boolean;
  title: string;
  label: string;
  hint?: string;
  defaultValue?: string;
  confirmLabel?: string;
  loading?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Replacement for `window.prompt()` — same job, but themable and visible to automated tests. */
export function PromptDialog({
  open,
  title,
  label,
  hint,
  defaultValue = '',
  confirmLabel = 'Confirmar',
  loading = false,
  onSubmit,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={submit} disabled={loading || !value.trim()}>
            {loading ? 'Aguarde…' : confirmLabel}
          </Button>
        </>
      }
    >
      <Field label={label} htmlFor="prompt-value" hint={hint}>
        <Input
          id="prompt-value"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
      </Field>
    </Modal>
  );
}
