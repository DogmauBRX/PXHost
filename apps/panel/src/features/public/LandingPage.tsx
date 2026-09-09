import { Archive, CalendarClock, Database, FolderOpen, ServerCog, ShieldCheck, TerminalSquare, Ticket, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Seo } from './Seo';
import { NetworkAnimation } from './NetworkAnimation';
import { ServerProvisionAnimation } from './ServerProvisionAnimation';
import { HeroCircuitBackground } from './HeroCircuitBackground';
import { BrazilLatencyMap } from './BrazilLatencyMap';
import { CircuitDivider } from './CircuitDivider';
import { NodeStatusSection } from './NodeStatusSection';

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

/**
 * Deliberately no CTA anywhere on this page (found live: an earlier
 * version had "Ver planos"/"Conhecer a plataforma" buttons) — this is
 * purely informational for now: what the platform is, and its
 * performance/security/reliability posture. `/plans` and account
 * creation are still reachable via the header, just not pushed from
 * here.
 */
export function LandingPage() {
  return (
    <>
      <Seo
        title="Hospedagem de servidores Minecraft"
        description="Hospedagem de servidores Minecraft com RAM, CPU e armazenamento dedicados, vagas limitadas por capacidade real e um painel completo."
        path="/"
      />

      {/* `min-h-[calc(100vh-4rem)]` — the header above this (PublicShell.tsx)
          is a fixed `h-16` (4rem), so this fills exactly the rest of the
          first screen on load: the visitor sees only the hero message and
          the network diagram at first, with the next section (and its
          Brazil map) needing a scroll to reach — not peeking in half-cut
          at the bottom of the viewport (found live). */}
      <section className="network-hero relative flex min-h-[calc(100vh-4rem)] items-center overflow-hidden px-4 py-20 sm:px-6 sm:py-28 lg:px-8">
        <HeroCircuitBackground className="network-hero__circuit pointer-events-none absolute inset-0 h-full w-full" />
        <div className="relative mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-14 lg:grid-cols-[1fr_1.2fr] lg:gap-10">
          <div className="hero-message-outline text-center lg:text-left">
            <h1 className="font-display text-5xl leading-tight font-bold tracking-tight text-text sm:text-6xl lg:text-7xl">Hospedagem de servidores Minecraft</h1>
            <p className="font-display mt-3 text-2xl font-semibold text-accent-strong">Sua infraestrutura. Sob seu controle.</p>
            {/* [-webkit-text-stroke:0] overrides the `.hero-message-outline`
                stroke this paragraph would otherwise inherit from the wrapper
                div — asked to keep the outline on the headline/tagline but
                drop it here, where the smaller text made the stroke read as
                clutter rather than emphasis. */}
            <p className="font-display mx-auto mt-5 max-w-xl text-base font-medium text-text-muted [-webkit-text-stroke:0] lg:mx-0">
              Performance dedicada, segurança em camadas e confiabilidade — infraestrutura real, sem overselling, para a sua comunidade.
            </p>
          </div>
          <NetworkAnimation />
        </div>
      </section>

      <section className="relative border-t border-border bg-surface-2/40 px-4 py-20 sm:px-6 lg:px-8">
        {/* No `max-w-*` cap on this grid (every other section on the page
            has one) — the divider is centered on the full section width,
            so each column needs to BE half of that same full width for
            its own centered content to land in the middle of its half
            rather than pulled toward the narrower center of a capped,
            mx-auto'd container (found live: with a cap, both blocks sat
            noticeably closer to the divider than to the section's outer
            edges). */}
        <CircuitDivider className="pointer-events-none absolute inset-y-0 left-1/2 hidden h-full w-10 -translate-x-1/2 lg:block" />
        <div className="grid grid-cols-1 items-center gap-16 lg:grid-cols-2 lg:gap-32">
          <div className="flex flex-col items-center text-center">
            <div className="mb-8 max-w-md">
              <h2 className="text-2xl font-bold text-text sm:text-3xl">Veja seu servidor entrar no ar</h2>
              <p className="mt-3 text-lg text-text-muted">
                Recursos reservados, aplicados de verdade — do provisionamento ao status <span className="text-ok">online</span>.
              </p>
            </div>
            <ServerProvisionAnimation />
          </div>

          <div className="flex flex-col items-center text-center">
            <BrazilLatencyMap />
            <div className="mt-6 max-w-md">
              <h3 className="text-2xl font-bold text-text sm:text-3xl">Cobertura em todo o território nacional</h3>
              <p className="mt-3 text-lg text-text-muted">
                Nodes distribuídos pelo Brasil garantem <span className="text-accent-strong">baixa latência</span> para os jogadores da sua
                comunidade, não importa de onde eles se conectam.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto mb-12 max-w-xl text-center">
          <h2 className="text-2xl font-bold text-text sm:text-3xl">Velocidade, segurança e confiabilidade</h2>
          <p className="mt-3 text-text-muted">Tudo que sustenta o seu servidor Minecraft por trás dos panos.</p>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {BENEFITS.map(({ icon: Icon, title, description }) => (
            <div key={title} className="rounded-card border border-border bg-surface p-6">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-xl bg-accent-tint">
                <Icon className="h-8 w-8 text-accent-strong" aria-hidden="true" />
              </div>
              <h3 className="text-base font-semibold text-text">{title}</h3>
              <p className="mt-1.5 text-sm text-text-muted">{description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* "Quadro indicativo" explaining the vagas model (commercial plan
          §7/§19: availability is always backend-computed, never invented
          by the frontend) — purely informational, same as everything
          else on this page now. */}
      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 rounded-card border border-accent/30 bg-accent-tint p-6 sm:flex-row sm:items-start sm:gap-5 sm:p-8">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface text-accent-strong shadow-sm">
            <Ticket className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text">Nossa hospedagem funciona por vagas</h2>
            <p className="mt-2 text-sm text-text-muted">
              Cada plano tem um número de vagas de acordo com a capacidade real dos nossos servidores — nunca vendemos além do que temos hardware
              para entregar. Quando as vagas de um plano se esgotam, ele fica indisponível até que uma vaga seja liberada. É assim que garantimos
              que todo servidor ativo recebe de verdade a RAM, o CPU e o disco que o plano promete, sem superlotação.
            </p>
          </div>
        </div>
      </section>

      <NodeStatusSection />
    </>
  );
}
