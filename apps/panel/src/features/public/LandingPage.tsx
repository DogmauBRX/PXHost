import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Archive, CalendarClock, Cpu, Database, FolderOpen, Gauge, HardDrive, Radio, ServerCog, ShieldCheck, TerminalSquare, Ticket, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Seo } from './Seo';
import { NetworkAnimation } from './NetworkAnimation';
import { ServerProvisionAnimation } from './ServerProvisionAnimation';
import { HeroCircuitBackground } from './HeroCircuitBackground';
import { BrazilLatencyMap } from './BrazilLatencyMap';

const LazyNodeStatusSection = lazy(() =>
  import('./NodeStatusSection').then((module) => ({ default: module.NodeStatusSection })),
);

function DeferredNodeStatusSection() {
  const markerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker || visible) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '500px 0px' },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={markerRef} className="min-h-40">
      {visible && (
        <Suspense fallback={<div className="h-40" aria-hidden="true" />}>
          <LazyNodeStatusSection />
        </Suspense>
      )}
    </div>
  );
}

// Only capabilities the platform actually has today (commercial plan
// §3: "não inventar funcionalidades que o sistema ainda não possui") —
// each one maps to a real module in the codebase, not a roadmap item.
// Curated (not the full feature list) to keep the homepage centered on
// what was explicitly asked for: platform capability, performance,
// security and reliability — not an exhaustive changelog.
const BENEFITS: { icon: LucideIcon; title: string; description: string }[] = [
  { icon: ServerCog, title: 'Infraestrutura multi-node', description: 'Servidores distribuídos em nodes independentes, com capacidade controlada — sem overselling.' },
  { icon: Zap, title: 'Performance dedicada', description: 'CPU e RAM reservados de verdade para o seu servidor — sem concorrência por recursos com outros clientes.' },
  { icon: ShieldCheck, title: 'Isolamento e permissões', description: 'Cada servidor roda isolado, e você controla exatamente o que cada colaborador pode fazer.' },
  { icon: Archive, title: 'Backups configuráveis', description: 'Proteja o progresso do seu mundo com backups sob seu controle.' },
  { icon: TerminalSquare, title: 'Console em tempo real', description: 'Acompanhe e envie comandos ao seu servidor direto do navegador, sem instalar nada.' },
  { icon: FolderOpen, title: 'Gerenciador de arquivos', description: 'Edite, envie e organize os arquivos do seu servidor com um gerenciador completo.' },
  { icon: Database, title: 'Bancos de dados MySQL', description: 'Crie e gerencie bancos de dados dedicados para seus plugins.' },
  { icon: CalendarClock, title: 'Agendamentos automáticos', description: 'Programe reinícios, backups e outras tarefas para rodar sozinhas.' },
];

export function LandingPage() {
  return (
    <>
      <Seo
        title="Hospedagem de servidores Minecraft"
        description="Hospedagem de servidores Minecraft com RAM, CPU e armazenamento dedicados, vagas limitadas por capacidade real e um painel completo."
        path="/"
      />

      <div className="landing-command overflow-hidden">
        <section className="network-hero relative flex min-h-[calc(100vh-4.75rem)] items-center overflow-hidden px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
          <HeroCircuitBackground className="network-hero__circuit pointer-events-none absolute inset-0 h-full w-full" />
          <div className="landing-hero__orb landing-hero__orb--one" aria-hidden="true" />
          <div className="landing-hero__orb landing-hero__orb--two" aria-hidden="true" />

          <div className="relative mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-14">
            <div className="text-center lg:text-left">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 font-mono text-[0.68rem] font-semibold tracking-[0.16em] text-accent uppercase">
                <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                Infraestrutura GX online
              </div>
              <h1 className="font-display text-5xl leading-[0.98] font-bold tracking-[-0.045em] text-text sm:text-6xl lg:text-[5rem]">
                Seu mundo online.
                <span className="landing-accent-text mt-2 block">Sem gargalos.</span>
              </h1>
              <p className="mt-6 text-xl font-semibold text-text sm:text-2xl">Hospedagem Minecraft sob seu controle.</p>
              <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-text-muted lg:mx-0">
                Recursos reservados, painel completo e infraestrutura distribuída para sua comunidade jogar com estabilidade — sem overselling.
              </p>

              <div className="mt-8 grid grid-cols-3 gap-2 sm:max-w-lg sm:gap-3 lg:mx-0">
                {[
                  { icon: Cpu, value: 'CPU', label: 'reservada' },
                  { icon: HardDrive, value: 'NVMe', label: 'rápido' },
                  { icon: ShieldCheck, value: '24/7', label: 'isolamento' },
                ].map(({ icon: Icon, value, label }) => (
                  <div key={value} className="landing-stat-chip rounded-xl border border-white/10 bg-white/[0.035] px-3 py-3 text-left backdrop-blur-sm">
                    <Icon className="mb-2 h-4 w-4 text-accent" aria-hidden="true" />
                    <strong className="block font-mono text-sm text-text">{value}</strong>
                    <span className="text-[0.68rem] text-text-faint">{label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="landing-network-stage relative">
              <div className="absolute top-[12%] left-[7%] z-10 rounded-full border border-white/10 bg-[#111318]/85 px-3 py-1 font-mono text-[0.6rem] tracking-wider text-text-faint uppercase backdrop-blur">
                GX network / live flow
              </div>
              <NetworkAnimation />
            </div>
          </div>
        </section>

        <section className="landing-section relative border-y border-white/8 px-4 py-24 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <div className="mb-12 grid gap-5 lg:grid-cols-[0.65fr_1fr] lg:items-end">
              <div>
                <span className="font-mono text-xs font-semibold tracking-[0.18em] text-accent uppercase">Operação inteligente</span>
                <h2 className="mt-3 text-3xl font-bold tracking-tight text-text sm:text-4xl">Da implantação à conexão.</h2>
              </div>
              <p className="max-w-2xl text-base leading-7 text-text-muted lg:justify-self-end">
                Uma experiência feita para reduzir atrito: recursos aplicados de verdade, acompanhamento visual e cobertura nacional.
              </p>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <article className="landing-feature-panel group relative overflow-hidden rounded-[1.75rem] border border-white/10 p-6 sm:p-8">
                <div className="mb-8 flex items-start justify-between gap-4">
                  <div>
                    <span className="font-mono text-[0.65rem] tracking-[0.16em] text-ok uppercase">Provisionamento</span>
                    <h3 className="mt-2 text-2xl font-bold text-text">Do zero ao online</h3>
                    <p className="mt-2 max-w-md text-sm leading-6 text-text-muted">CPU, memória e armazenamento preparados enquanto você acompanha cada etapa.</p>
                  </div>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-ok/20 bg-ok/10 text-ok"><Gauge className="h-5 w-5" /></span>
                </div>
                <ServerProvisionAnimation />
              </article>

              <article className="landing-feature-panel group relative overflow-hidden rounded-[1.75rem] border border-white/10 p-6 sm:p-8">
                <div className="grid items-center gap-2 sm:grid-cols-[0.9fr_1.1fr]">
                  <div>
                    <span className="font-mono text-[0.65rem] tracking-[0.16em] text-accent uppercase">Rede nacional</span>
                    <h3 className="mt-2 text-2xl font-bold text-text">Perto de quem joga</h3>
                    <p className="mt-3 text-sm leading-6 text-text-muted">Nodes distribuídos pelo Brasil ajudam a manter baixa latência para jogadores de diferentes regiões.</p>
                  </div>
                  <BrazilLatencyMap />
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="relative px-4 py-24 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <div className="mx-auto mb-14 max-w-2xl text-center">
              <span className="font-mono text-xs font-semibold tracking-[0.18em] text-accent uppercase">Painel de comando</span>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-text sm:text-4xl">Tudo o que mantém seu servidor em movimento.</h2>
              <p className="mt-4 text-text-muted">Controle técnico com uma interface simples, do console aos backups.</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {BENEFITS.map(({ icon: Icon, title, description }, index) => (
                <article key={title} className="landing-benefit-card group relative overflow-hidden rounded-2xl border border-white/10 p-5">
                  <span className="absolute top-4 right-4 font-mono text-[0.6rem] text-white/20">0{index + 1}</span>
                  <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent transition-transform duration-300 group-hover:-translate-y-1 group-hover:rotate-3">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="text-base font-semibold text-text">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-text-muted">{description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
          <div className="landing-capacity-panel relative overflow-hidden rounded-[1.75rem] border border-accent/25 p-6 sm:p-8">
            <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-accent/25 bg-accent/10 text-accent shadow-[0_0_25px_-10px_var(--color-accent)]">
                <Ticket className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="flex-1">
                <span className="font-mono text-[0.65rem] tracking-[0.16em] text-accent uppercase">Capacidade real</span>
                <h2 className="mt-1 text-xl font-semibold text-text">Hospedagem por vagas, sem superlotação</h2>
                <p className="mt-2 max-w-4xl text-sm leading-6 text-text-muted">
                  Cada plano respeita a capacidade física disponível. Quando as vagas terminam, novas ativações pausam até existir recurso livre — assim RAM, CPU e disco continuam entregando o que foi contratado.
                </p>
              </div>
            </div>
          </div>
        </section>

        <DeferredNodeStatusSection />
      </div>
    </>
  );
}
