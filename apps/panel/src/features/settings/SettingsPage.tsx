import { Monitor, Moon, Sun } from 'lucide-react';
import { useAuthStore } from '@/shared/stores/auth.store';
import { useThemeStore } from '@/shared/theme/theme.store';
import { Avatar, Card, CardBody, CardHeader, CardTitle, CardDescription, PageHeader } from '@/ui/primitives';

export function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <>
      <PageHeader title="Configurações" subtitle="Preferências da sua conta e do painel." />

      <div className="grid max-w-3xl gap-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Aparência</CardTitle>
              <CardDescription>Escolha como o painel deve ser exibido neste navegador.</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  { value: 'light', label: 'Claro', icon: Sun },
                  { value: 'dark', label: 'Escuro', icon: Moon },
                ] as const
              ).map(({ value, label, icon: Icon }) => {
                const active = theme === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTheme(value)}
                    aria-pressed={active}
                    className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition ${
                      active
                        ? 'border-accent bg-accent-tint text-accent-strong'
                        : 'border-border bg-surface text-text hover:border-border-strong'
                    }`}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-text-faint">
              <Monitor className="h-3.5 w-3.5" aria-hidden="true" />A preferência fica salva apenas neste navegador.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Conta</CardTitle>
              <CardDescription>Dados da sessão atual.</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <div className="flex items-center gap-4">
              <Avatar name={user?.username} email={user?.email} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">{user?.username ?? '—'}</p>
                <p className="truncate text-sm text-text-muted">{user?.email ?? '—'}</p>
                <p className="mt-1 text-xs text-text-faint">
                  {user?.isAdmin ? 'Administrador' : 'Cliente'}
                </p>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
