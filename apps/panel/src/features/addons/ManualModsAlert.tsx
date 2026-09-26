import { ExternalLink } from 'lucide-react';
import { Alert } from '@/ui/primitives';
import type { ModpackInstallation } from './modpacks.api';

export function ManualModsAlert({ files, addonDir, className }: { files: ModpackInstallation['manualFiles']; addonDir?: string | null; className?: string }) {
  if (!files || files.length === 0) return null;
  return (
    <Alert tone="warn" className={className} title={`${files.length} ${files.length === 1 ? 'mod precisa' : 'mods precisam'} ser adicionado${files.length === 1 ? '' : 's'} manualmente`}>
      <p>
        {files.length === 1 ? 'O autor deste mod não permite' : 'Os autores destes mods não permitem'} download por aplicativos de terceiros, então o modpack foi instalado sem {files.length === 1 ? 'ele' : 'eles'}.
        Baixe cada arquivo abaixo e envie pelo gerenciador de arquivos para a pasta <code className="rounded bg-surface-2 px-1 font-mono text-xs">{addonDir ?? 'mods'}</code>. Se o servidor não iniciar, é provável que falte um destes.
      </p>
      <ul className="mt-2 space-y-1">
        {files.map((file) => (
          <li key={file.filename}>
            <a className="inline-flex items-center gap-1 font-medium underline" href={file.pageUrl} target="_blank" rel="noreferrer">
              {file.name} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
            <span className="ml-2 font-mono text-xs text-text-faint">{file.filename}</span>
          </li>
        ))}
      </ul>
    </Alert>
  );
}
