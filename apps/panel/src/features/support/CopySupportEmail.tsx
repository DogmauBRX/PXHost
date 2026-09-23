import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Mail } from 'lucide-react';

export const SUPPORT_EMAIL = 'gxhostbr@gmail.com';

interface CopySupportEmailProps {
  className?: string;
  label?: string;
  icon?: 'mail' | 'copy' | 'none';
}

export function CopySupportEmail({ className = '', label = SUPPORT_EMAIL, icon = 'copy' }: CopySupportEmailProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL);
    } catch {
      const input = document.createElement('textarea');
      input.value = SUPPORT_EMAIL;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2_000);
  }

  const Icon = copied ? Check : icon === 'mail' ? Mail : Copy;

  return (
    <button
      type="button"
      onClick={() => void copyEmail()}
      className={className}
      aria-label={copied ? 'E-mail copiado' : `Copiar e-mail ${SUPPORT_EMAIL}`}
      title={copied ? 'E-mail copiado' : 'Copiar e-mail'}
    >
      {icon !== 'none' && <Icon className={`h-4 w-4 ${copied ? 'text-ok' : ''}`} aria-hidden="true" />}
      {copied ? 'E-mail copiado!' : label}
    </button>
  );
}
