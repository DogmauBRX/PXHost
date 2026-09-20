import { useEffect, useRef, useState } from 'react';
import { OctagonAlert, Play, RotateCcw, Square } from 'lucide-react';
import { Button } from '@/ui/primitives/Button';
import type { PowerAction } from '@/shared/api/types';

interface PowerControlsProps {
  state: string;
  permissions: string[];
  onAction: (action: PowerAction) => void;
}

const LABEL: Record<PowerAction, string> = { start: 'Iniciar', stop: 'Parar', restart: 'Reiniciar', kill: 'Forçar parada' };
const PERM: Record<PowerAction, string> = { start: 'control.start', stop: 'control.stop', restart: 'control.restart', kill: 'control.kill' };

export function PowerControls({ state, permissions, onAction }: PowerControlsProps) {
  const [armedKill, setArmedKill] = useState(false);
  const armTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (armTimer.current) window.clearTimeout(armTimer.current);
  }, []);

  const running = state === 'running' || state === 'starting';
  const canStart = !running;
  const canStop = state === 'running';

  function handleKillClick() {
    if (!armedKill) {
      setArmedKill(true);
      armTimer.current = window.setTimeout(() => setArmedKill(false), 3000);
      return;
    }
    if (armTimer.current) window.clearTimeout(armTimer.current);
    setArmedKill(false);
    onAction('kill');
  }

  function has(action: PowerAction) {
    return permissions.includes(PERM[action]);
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="primary" disabled={!canStart || !has('start')} onClick={() => onAction('start')}>
        <Play className="h-4 w-4" aria-hidden="true" />
        {LABEL.start}
      </Button>
      <Button variant="secondary" disabled={!canStop || !has('restart')} onClick={() => onAction('restart')}>
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        {LABEL.restart}
      </Button>
      <Button variant="secondary" disabled={!canStop || !has('stop')} onClick={() => onAction('stop')}>
        <Square className="h-3.5 w-3.5" aria-hidden="true" />
        {LABEL.stop}
      </Button>
      <Button
        variant="danger"
        disabled={!has('kill')}
        onClick={handleKillClick}
        title={armedKill ? 'Clique novamente para confirmar' : undefined}
      >
        <OctagonAlert className="h-4 w-4" aria-hidden="true" />
        {armedKill ? 'Confirmar?' : LABEL.kill}
      </Button>
    </div>
  );
}
