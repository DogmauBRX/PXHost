import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { ApiError } from '@/shared/api/client';
import { Button, ConfirmDialog } from '@/ui/primitives';
import { reinstallCurrentServerVersion } from './servers.api';

export function ReinstallCurrentVersionButton({
  serverId,
  disabled = false,
  onStarted,
  onError,
}: {
  serverId: string;
  disabled?: boolean;
  onStarted?: () => void;
  onError?: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation({
    mutationFn: () => reinstallCurrentServerVersion(serverId),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
      void queryClient.invalidateQueries({ queryKey: ['server', 'stats', serverId] });
      void queryClient.invalidateQueries({ queryKey: ['server-variables', serverId] });
      onStarted?.();
    },
    onError: (error) => {
      onError?.(error instanceof ApiError ? error.message : 'Não foi possível reinstalar a versão atual.');
    },
  });

  return (
    <>
      <Button
        variant="secondary"
        disabled={disabled || mutation.isPending}
        title={disabled ? 'Pare o servidor para reinstalar a versão atual.' : undefined}
        onClick={() => setConfirming(true)}
      >
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        Reinstalar versão atual
      </Button>
      <ConfirmDialog
        open={confirming}
        title="Reinstalar versão atual"
        message="A versão e o software atuais serão baixados e instalados novamente. O mundo, mods, plugins, configurações e variáveis atuais serão preservados. O servidor precisa permanecer parado durante a instalação."
        confirmLabel={mutation.isPending ? 'Reinstalando…' : 'Reinstalar versão atual'}
        loading={mutation.isPending}
        onConfirm={() => mutation.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
