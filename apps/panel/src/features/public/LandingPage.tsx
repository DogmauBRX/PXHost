import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bot, CalendarClock, Database, FolderOpen, ServerCog, ShieldCheck, TerminalSquare, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { listPublicPlans } from './public.api';
import { PlanCard } from './PlanCard';
import { Seo } from './Seo';
import { Button, Skeleton } from '@/ui/primitives';

// Only capabilities the platform actually has today (commercial plan
// §3: "não inventar funcionalidades que o sistema ainda não possui") —
// each one maps to a real module in the codebase, not a roadmap item.
const BENEFITS: { icon: LucideIcon; title: string; description: string }[] = [
  { icon: ServerCog, title: 'Infraestrutura multi-node', description: 'Servidores distribuídos em nodes independentes, com capacidade controlada — sem overselling.' },
  { icon: TerminalSquare, title: 'Console em tempo real', description: 'Acompanhe e envie comandos ao seu servidor direto do navegador, sem instalar nada.' },
  { icon: FolderOpen, title: 'Gerenciador de arquivos', description: 'Edite, envie e organize os arquivos do seu servidor com um gerenciador completo.' },
  { icon: Database, title: 'Bancos de dados MySQL', description: 'Crie e gerencie bancos de dados dedicados para seus plugins e mods.' },
  { icon: CalendarClock, title: 'Agendamentos automáticos', description: 'Programe reinícios, backups e outras tarefas para rodar sozinhas.' },
  { icon: Users, title: 'Colaboradores com permissões', description: 'Convide sua equipe com controle fino sobre o que cada pessoa pode fazer.' },
  { icon: Bot, title: 'Assistente integrado', description: 'Tire dúvidas sobre configuração e uso do painel sem sair do servidor.' },
  { icon: ShieldCheck, title: 'Isolamento entre servidores', description: 'Cada servidor roda isolado, com limites de CPU, RAM e disco aplicados de verdade.' },
];

export function LandingPage() {
  const { data: plans, isLoading } = useQuery({ queryKey: ['public-plans'], queryFn: listPublicPlans });
  const preview = (plans ?? []).slice(0, 3);

  return (
    <>
      <Seo
        title="Hospedagem de servidores de jogos"
        description="Crie e gerencie seu próprio servidor de jogos com a PXHost: planos com RAM, CPU e armazenamento dedicados, e um painel completo."
        path="/"
      />

      <section className="login-hero relative px-4 py-20 sm:px-6 sm:py-28 lg:px-8">
        <div className="relative mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-bold text-text sm:text-5xl">Sua comunidade. Seu servidor. Sua infraestrutura.</h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-text-muted">
            Escolha um plano, contrate em minutos e gerencie tudo em um painel moderno — console, arquivos, backups e muito mais.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to="/plans">
              <Button variant="primary" size="md" className="h-12 w-full px-8 text-base sm:w-auto">
                Ver planos
              </Button>
            </Link>
            <a href="#recursos">
              <Button variant="secondary" size="md" className="h-12 w-full px-8 text-base sm:w-auto">
                Conhecer a plataforma
              </Button>
            </a>
          </div>
        </div>
      </section>

      <section id="recursos" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto mb-12 max-w-xl text-center">
          <h2 className="text-2xl font-bold text-text sm:text-3xl">Tudo que você precisa para rodar seu servidor</h2>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {BENEFITS.map(({ icon: Icon, title, description }) => (
            <div key={title} className="rounded-card border border-border bg-surface p-5">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent-tint">
                <Icon className="h-5 w-5 text-accent-strong" aria-hidden="true" />
              </div>
              <h3 className="text-sm font-semibold text-text">{title}</h3>
              <p className="mt-1 text-sm text-text-muted">{description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border bg-surface-2/40 px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-10 flex flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
            <div>
              <h2 className="text-2xl font-bold text-text sm:text-3xl">Planos para todo tamanho de comunidade</h2>
              <p className="mt-2 text-text-muted">RAM, CPU e armazenamento sob medida — sem taxas escondidas.</p>
            </div>
            <Link to="/plans" className="shrink-0">
              <Button variant="secondary">Ver todos os planos</Button>
            </Link>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-80 w-full rounded-card" />
              ))}
            </div>
          ) : preview.length === 0 ? (
            <p className="text-center text-sm text-text-muted">Nenhum plano publicado no momento.</p>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {preview.map((p) => (
                <PlanCard key={p.id} plan={p} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="px-4 py-20 text-center sm:px-6 lg:px-8">
        <h2 className="text-2xl font-bold text-text sm:text-3xl">Pronto para colocar seu servidor no ar?</h2>
        <div className="mt-6">
          <Link to="/plans">
            <Button variant="primary" size="md" className="h-12 px-8 text-base">
              Ver planos
            </Button>
          </Link>
        </div>
      </section>
    </>
  );
}
