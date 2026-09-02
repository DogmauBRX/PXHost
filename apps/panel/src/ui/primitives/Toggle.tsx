interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  label?: string;
  description?: string;
}

/**
 * Capacity plan Fase 3 — the node edit modal's first real switch-style
 * boolean (`maintenanceMode`, "vender acima do físico"). Every existing
 * boolean field in the panel today (`isPublic` on plans, etc.) uses a
 * raw `<input type="checkbox">` — this doesn't replace those, it's for
 * the new capacity fields where "on/off" reads more like a mode switch
 * than a checkbox in a form.
 */
export function Toggle({ checked, onChange, id, disabled, label, description }: ToggleProps) {
  const button = (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-surface-2'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  );

  if (!label && !description) return button;

  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        {label && (
          <label htmlFor={id} className="text-sm font-medium text-text">
            {label}
          </label>
        )}
        {description && <p className="text-xs text-text-faint">{description}</p>}
      </div>
      {button}
    </div>
  );
}
