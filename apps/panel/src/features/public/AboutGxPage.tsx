import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  CheckCircle2,
  CloudCog,
  Database,
  FileArchive,
  Files,
  Gauge,
  HardDrive,
  Headphones,
  Maximize2,
  Play,
  Server,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  TicketCheck,
  UsersRound,
  Workflow,
} from 'lucide-react';
import { Modal } from '@/ui/primitives';
import { HeroCircuitBackground } from './HeroCircuitBackground';
import { Seo } from './Seo';

const journey = [
  {
    number: '01',
    icon: CheckCircle2,
    title: 'Escolha o plano',
    description: 'Compare recursos, ciclo de cobrança e capacidade antes de contratar.',
  },
  {
    number: '02',
    icon: ShieldCheck,
    title: 'Pague com segurança',
    description: 'O pagamento é concluído no ambiente seguro do provedor escolhido.',
  },
  {
    number: '03',
    icon: CloudCog,
    title: 'Provisionamento automático',
    description: 'A confirmação ativa a assinatura e inicia a criação do servidor em um node compatível.',
  },
  {
    number: '04',
    icon: Gauge,
    title: 'Controle pelo painel',
    description: 'Gerencie o servidor, acompanhe recursos e peça ajuda em um único lugar.',
  },
];

const features = [
  { icon: SquareTerminal, title: 'Console em tempo real', description: 'Acompanhe a inicialização, leia logs e envie comandos diretamente pelo navegador.' },
  { icon: Play, title: 'Controles de energia', description: 'Inicie, reinicie e pare seu servidor sem depender do suporte.' },
  { icon: Files, title: 'Arquivos e configurações', description: 'Edite arquivos, variáveis de inicialização e ajustes do servidor pelo painel.' },
  { icon: Settings2, title: 'Mods e plugins', description: 'Instale complementos compatíveis e adapte o servidor à sua comunidade.' },
  { icon: FileArchive, title: 'Backups', description: 'Crie e restaure cópias de segurança dentro dos limites do seu plano.' },
  { icon: Database, title: 'Bancos MySQL', description: 'Crie bancos e credenciais para plugins que precisam persistir dados.' },
  { icon: Workflow, title: 'Agendamentos', description: 'Automatize rotinas e comandos para reduzir tarefas repetitivas.' },
  { icon: UsersRound, title: 'Acesso compartilhado', description: 'Adicione subusuários e controle as permissões de cada pessoa.' },
];

const screenshots = [
  {
    src: '/images/about-gx/client-overview.png',
    eyebrow: 'Visão geral',
    title: 'Todos os servidores em uma tela',
    description: 'Veja quantos servidores estão online, o software instalado, a memória disponível e o endereço de conexão.',
  },
  {
    src: '/images/about-gx/server-control.png',
    eyebrow: 'Controle do servidor',
    title: 'Operação e diagnóstico em tempo real',
    description: 'Console, consumo de CPU, RAM e armazenamento, comandos de energia e atalhos para os principais recursos.',
  },
  {
    src: '/images/about-gx/client-assistant.png',
    eyebrow: 'Assistente GX',
    title: 'Ajuda contextual dentro do painel',
    description: 'Respostas rápidas para tarefas comuns como backups, mods, plugins, arquivos, acesso e configuração.',
  },
];

export function AboutGxPage() {
  const [selectedScreenshot, setSelectedScreenshot] = useState<(typeof screenshots)[number] | null>(null);

  return (
    <div className="plans-command relative min-h-screen overflow-hidden">
      <Seo
        title="Sobre o GX"
        description="Conheça a plataforma GXhost e veja como contratar, provisionar e administrar seu servidor Minecraft pelo painel do cliente."
        path="/sobre"
      />

      <HeroCircuitBackground className="plans-command__circuit pointer-events-none absolute inset-x-0 top-0 h-[52rem] w-full" />
      <div className="plans-command__glow" aria-hidden="true" />

      <section className="relative mx-auto max-w-7xl px-4 pt-16 pb-12 sm:px-6 sm:pt-20 lg:px-8 lg:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-[0.88fr_1.12fr] lg:gap-16">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 font-mono text-[0.68rem] font-semibold tracking-[0.16em] text-accent uppercase">
              <Server className="h-3.5 w-3.5" aria-hidden="true" />
              Sobre o GX
            </div>
            <h1 className="mt-5 text-4xl leading-[1.06] font-bold tracking-[-0.045em] text-text sm:text-5xl lg:text-6xl">
              Seu servidor, do pagamento ao controle, <span className="plans-accent-text">em uma só plataforma.</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-text-muted sm:text-lg">
              A GXhost reúne contratação, ativação, hospedagem e gerenciamento de servidores Minecraft. Depois da confirmação do pagamento, a plataforma prepara o ambiente e entrega o controle ao cliente pelo navegador.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link to="/plans" className="group inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-accent px-6 text-sm font-semibold text-accent-contrast shadow-[0_14px_35px_-18px_var(--color-accent)] transition-all hover:-translate-y-0.5 hover:bg-accent-strong">
                Conhecer os planos
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
              <Link to="/central" className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-6 text-sm font-semibold text-text-muted transition-all hover:border-accent/30 hover:bg-white/[0.06] hover:text-text">
                Como funciona a contratação
              </Link>
            </div>

            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm text-text-muted">
              {['Painel pelo navegador', 'Provisionamento automático', 'Suporte por ticket'].map((item) => (
                <span key={item} className="inline-flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden="true" />
                  {item}
                </span>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="absolute -inset-8 bg-accent/10 blur-3xl" aria-hidden="true" />
            <ScreenshotFrame src="/images/about-gx/client-overview.png" alt="Visão geral do painel do cliente GXhost com servidores de teste" priority />
            <div className="absolute -bottom-5 left-5 flex items-center gap-3 rounded-xl border border-white/10 bg-[#171a20]/95 px-4 py-3 shadow-2xl backdrop-blur sm:left-8">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ok/10 text-ok"><HardDrive className="h-4 w-4" /></span>
              <div>
                <p className="text-xs font-semibold text-text">Painel centralizado</p>
                <p className="text-[0.68rem] text-text-faint">Status e acesso em poucos cliques</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="mb-9 max-w-2xl">
          <p className="font-mono text-[0.68rem] font-bold tracking-[0.18em] text-accent uppercase">Da escolha ao primeiro acesso</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-text sm:text-4xl">Como a plataforma funciona</h2>
          <p className="mt-4 text-base leading-7 text-text-muted">O processo liga o catálogo, o pagamento e a infraestrutura. Cada etapa atualiza o status mostrado no painel.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {journey.map((step) => (
            <article key={step.number} className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-all hover:-translate-y-1 hover:border-accent/25 hover:bg-white/[0.045]">
              <div className="absolute top-4 right-4 font-mono text-[0.62rem] font-bold tracking-widest text-accent/45">{step.number}</div>
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent transition-transform group-hover:scale-105">
                <step.icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-lg font-semibold text-text">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-text-muted">{step.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="relative border-y border-white/[0.07] bg-white/[0.018]">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
            <div className="lg:sticky lg:top-28">
              <p className="font-mono text-[0.68rem] font-bold tracking-[0.18em] text-accent uppercase">Ferramentas do cliente</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-text sm:text-4xl">Autonomia para cuidar do servidor</h2>
              <p className="mt-4 text-base leading-7 text-text-muted">As funções mais usadas ficam organizadas por servidor. Você acompanha a operação e faz ajustes sem abrir um chamado para cada tarefa.</p>
              <div className="mt-7 rounded-2xl border border-ok/15 bg-ok/[0.045] p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-text"><TicketCheck className="h-4 w-4 text-ok" />Quando precisar, o suporte está no painel</div>
                <p className="mt-2 text-sm leading-6 text-text-muted">Abra tickets, acompanhe respostas e mantenha o histórico do atendimento na sua conta.</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {features.map((feature) => (
                <article key={feature.title} className="rounded-2xl border border-white/[0.08] bg-[#171a20]/65 p-5 transition-colors hover:border-accent/20 hover:bg-[#1a1d23]">
                  <feature.icon className="h-5 w-5 text-accent" aria-hidden="true" />
                  <h3 className="mt-4 font-semibold text-text">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-text-muted">{feature.description}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="font-mono text-[0.68rem] font-bold tracking-[0.18em] text-accent uppercase">O painel por dentro</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-text sm:text-4xl">Veja as principais telas do cliente</h2>
          <p className="mt-4 text-base leading-7 text-text-muted">Capturas reais do painel GXhost usando servidores de teste, sem dados de clientes.</p>
        </div>

        <div className="mt-12 space-y-16">
          {screenshots.map((shot) => (
            <article key={shot.src}>
              <div className="mb-5 max-w-3xl">
                <p className="font-mono text-[0.64rem] font-bold tracking-[0.17em] text-accent uppercase">{shot.eyebrow}</p>
                <h3 className="mt-2 text-2xl font-semibold tracking-tight text-text">{shot.title}</h3>
                <p className="mt-3 text-sm leading-7 text-text-muted">{shot.description}</p>
              </div>
              <ScreenshotFrame src={shot.src} alt={`${shot.title} no painel do cliente GXhost`} onOpen={() => setSelectedScreenshot(shot)} />
            </article>
          ))}
        </div>
      </section>

      <section className="relative mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8">
        <div className="overflow-hidden rounded-3xl border border-accent/20 bg-[linear-gradient(120deg,rgba(255,111,15,0.12),rgba(255,255,255,0.025)_45%,rgba(36,205,134,0.06))] px-6 py-10 sm:px-10 lg:flex lg:items-center lg:justify-between lg:px-12">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-sm font-semibold text-accent"><Headphones className="h-4 w-4" />Infraestrutura e atendimento no mesmo ecossistema</div>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-text">Pronto para montar seu servidor?</h2>
            <p className="mt-3 text-sm leading-6 text-text-muted">Escolha os recursos, conclua o pagamento e acompanhe todo o processo pelo painel.</p>
          </div>
          <Link to="/plans" className="group mt-7 inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-6 text-sm font-semibold text-accent-contrast shadow-[0_14px_35px_-18px_var(--color-accent)] transition-all hover:-translate-y-0.5 hover:bg-accent-strong lg:mt-0">
            Ver planos disponíveis
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        </div>
      </section>

      <Modal
        open={selectedScreenshot !== null}
        onClose={() => setSelectedScreenshot(null)}
        title={selectedScreenshot?.title ?? 'Captura do painel'}
        description="Captura real do painel GXhost com dados de teste."
        size="xl"
      >
        {selectedScreenshot && (
          <img
            src={selectedScreenshot.src}
            alt={`${selectedScreenshot.title} ampliado`}
            className="max-h-[68vh] w-full rounded-xl border border-white/10 bg-[#111419] object-contain"
          />
        )}
      </Modal>
    </div>
  );
}

function ScreenshotFrame({ src, alt, priority = false, onOpen }: { src: string; alt: string; priority?: boolean; onOpen?: () => void }) {
  const screenshot = <img src={src} alt={alt} loading={priority ? 'eager' : 'lazy'} className="block aspect-[16/9] w-full object-cover object-top" />;

  return (
    <figure className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#111419] shadow-[0_28px_70px_-35px_rgba(0,0,0,0.95)]">
      <div className="flex h-9 items-center gap-1.5 border-b border-white/[0.07] bg-white/[0.035] px-4" aria-hidden="true">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-300/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        <span className="ml-3 font-mono text-[0.58rem] tracking-wider text-white/25 uppercase">painel.gxhost</span>
      </div>
      {onOpen ? (
        <button type="button" onClick={onOpen} className="group relative block w-full cursor-zoom-in text-left" aria-label={`Ampliar: ${alt}`}>
          {screenshot}
          <span className="absolute right-4 bottom-4 inline-flex items-center gap-2 rounded-xl border border-white/15 bg-[#111419]/90 px-3 py-2 text-xs font-semibold text-white/80 opacity-90 shadow-lg backdrop-blur transition group-hover:border-accent/35 group-hover:text-accent sm:px-4 sm:py-2.5">
            <Maximize2 className="h-4 w-4" aria-hidden="true" />
            Clique para ampliar
          </span>
        </button>
      ) : screenshot}
    </figure>
  );
}
