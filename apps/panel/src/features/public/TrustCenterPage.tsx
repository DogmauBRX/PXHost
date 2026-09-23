import {
  ArrowRight,
  BadgeCheck,
  Check,
  Clock3,
  CreditCard,
  FileCheck2,
  LifeBuoy,
  Mail,
  MessageSquareText,
  QrCode,
  Radar,
  ReceiptText,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';
import { HeroCircuitBackground } from './HeroCircuitBackground';
import { Seo } from './Seo';
import { CopySupportEmail, SUPPORT_EMAIL } from '@/features/support/CopySupportEmail';

const summaryCards = [
  {
    href: '#pagamentos',
    icon: CreditCard,
    eyebrow: 'Cobrança transparente',
    title: 'Pagamentos',
    description: 'Pix por ciclo ou cartão recorrente, processados com segurança pelo Mercado Pago ou PagBank.',
  },
  {
    href: '#reembolsos',
    icon: RefreshCcw,
    eyebrow: 'Direito de arrependimento',
    title: 'Reembolsos',
    description: 'Processo claro para solicitar cancelamento e devolução dentro do prazo legal.',
  },
  {
    href: '#seguranca',
    icon: ShieldAlert,
    eyebrow: 'Resposta a incidentes',
    title: 'Segurança',
    description: 'Detecção e contenção rápida de DoS/DDoS, invasões e outros padrões de ataque.',
  },
  {
    href: '#suporte',
    icon: LifeBuoy,
    eyebrow: 'Canal oficial',
    title: 'Suporte',
    description: `Atendimento registrado pelo e-mail ${SUPPORT_EMAIL}.`,
  },
];

const refundSteps = [
  {
    number: '01',
    title: 'Envie a solicitação',
    description: `Escreva para ${SUPPORT_EMAIL} usando o e-mail da sua conta e informe o servidor ou pedido.`,
  },
  {
    number: '02',
    title: 'Receba a confirmação',
    description: 'A equipe registra o pedido, confirma o recebimento e confere os dados da contratação.',
  },
  {
    number: '03',
    title: 'Acompanhe o estorno',
    description: 'Após o processamento, o prazo para o crédito aparecer depende do meio de pagamento e da instituição financeira.',
  },
];

export function TrustCenterPage() {
  return (
    <div className="plans-command relative min-h-screen overflow-hidden">
      <Seo
        title="Central GX"
        description="Entenda como funcionam pagamentos, reembolsos e o suporte oficial da GXhost."
        path="/central"
      />

      <HeroCircuitBackground className="plans-command__circuit pointer-events-none absolute inset-x-0 top-0 h-[46rem] w-full" />
      <div className="plans-command__glow" aria-hidden="true" />

      <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <section className="mx-auto max-w-4xl text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 font-mono text-[0.68rem] font-semibold tracking-[0.16em] text-accent uppercase">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Central GX
          </div>
          <h1 className="text-4xl leading-tight font-bold tracking-[-0.04em] text-text sm:text-5xl lg:text-6xl">
            Clareza antes, durante e <span className="plans-accent-text">depois da contratação.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-text-muted sm:text-lg">
            Reunimos em um só lugar como cobramos, como solicitar um reembolso e onde falar com a equipe. Sem letras escondidas.
          </p>
        </section>

        <section className="mt-12 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Assuntos da Central GX">
          {summaryCards.map(({ href, icon: Icon, eyebrow, title, description }) => (
            <a key={href} href={href} className="plan-command-card group rounded-2xl border p-5">
              <span className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="text-[0.62rem] font-bold tracking-[0.16em] text-accent/75 uppercase">{eyebrow}</span>
              <h2 className="mt-1.5 flex items-center justify-between text-xl font-semibold text-text">
                {title}
                <ArrowRight className="h-4 w-4 text-text-faint transition-transform group-hover:translate-x-1 group-hover:text-accent" aria-hidden="true" />
              </h2>
              <p className="mt-2 text-sm leading-6 text-text-muted">{description}</p>
            </a>
          ))}
        </section>

        <div id="transparencia" className="mt-10 grid scroll-mt-28 gap-3 rounded-2xl border border-white/10 bg-white/[0.025] p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-4">
          {[
            { icon: BadgeCheck, label: 'Provedores de pagamento', value: 'Mercado Pago e PagBank' },
            { icon: Clock3, label: 'Prazo de arrependimento', value: '7 dias corridos' },
            { icon: Mail, label: 'Suporte oficial', value: SUPPORT_EMAIL },
            { icon: ShieldAlert, label: 'Resposta a incidentes', value: 'Detecção e contenção' },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-black/10 px-4 py-3">
              <Icon className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              <span><span className="block text-[0.62rem] font-semibold tracking-wider text-text-faint uppercase">{label}</span><strong className="mt-0.5 block text-sm font-semibold text-text">{value}</strong></span>
            </div>
          ))}
        </div>

        <section id="pagamentos" className="scroll-mt-28 border-b border-white/8 py-20">
          <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
            <div>
              <span className="font-mono text-[0.68rem] font-bold tracking-[0.18em] text-accent uppercase">01 · Pagamentos</span>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-text sm:text-4xl">Você escolhe como renovar.</h2>
              <p className="mt-4 max-w-lg text-base leading-7 text-text-muted">Os valores e a periodicidade aparecem antes da confirmação. A cobrança é criada e conciliada pelo provedor escolhido; a GXhost não armazena os dados completos do seu cartão.</p>
              <div className="mt-6 space-y-3">
                {[
                  'Ativação iniciada após a confirmação do pagamento pelo provedor.',
                  'Status do pedido e da assinatura disponível na área do cliente.',
                  'Preço e período sempre apresentados antes de gerar a cobrança.',
                ].map((item) => (
                  <p key={item} className="flex items-start gap-2.5 text-sm leading-6 text-text-muted"><Check className="mt-1 h-4 w-4 shrink-0 text-ok" aria-hidden="true" />{item}</p>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <article className="plan-command-card rounded-2xl border p-5">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent"><QrCode className="h-5 w-5" /></span>
                <h3 className="mt-5 text-lg font-semibold text-text">Pix por período</h3>
                <p className="mt-2 text-sm leading-6 text-text-muted">Você gera e paga um novo QR Code em cada ciclo. Não existe débito automático no Pix.</p>
                <span className="mt-5 inline-flex rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-[0.62rem] font-semibold tracking-wide text-text-faint uppercase">Controle manual</span>
              </article>

              <article className="plan-command-card rounded-2xl border p-5">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent"><CreditCard className="h-5 w-5" /></span>
                <h3 className="mt-5 text-lg font-semibold text-text">Cartão recorrente</h3>
                <p className="mt-2 text-sm leading-6 text-text-muted">A renovação ocorre automaticamente no período escolhido. Os dados são preenchidos no ambiente seguro do provedor selecionado.</p>
                <span className="mt-5 inline-flex rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-[0.62rem] font-semibold tracking-wide text-text-faint uppercase">Renovação automática</span>
              </article>
            </div>
          </div>
        </section>

        <section id="seguranca" className="scroll-mt-28 border-b border-white/8 py-20">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
            <div>
              <span className="font-mono text-[0.68rem] font-bold tracking-[0.18em] text-accent uppercase">02 · Segurança</span>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-text sm:text-4xl">Resposta rápida quando o tráfego vira ataque.</h2>
              <p className="mt-4 max-w-xl text-base leading-7 text-text-muted">Sinais de DoS/DDoS, tentativas de invasão, spoofing e varreduras abusivas recebem prioridade operacional. O objetivo é identificar o padrão, conter o impacto e preservar os demais serviços.</p>

              <div className="mt-7 rounded-2xl border border-amber-300/15 bg-amber-300/[0.045] p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-text"><ShieldAlert className="h-4 w-4 text-amber-300" />Proteção responsável e transparente</div>
                <p className="mt-2 text-sm leading-6 text-text-muted">Nenhuma solução elimina todo risco. Ataques complexos podem causar degradação temporária enquanto as rotas são filtradas ou isoladas.</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              {[
                { icon: Radar, step: '01', title: 'Detectar', description: 'Análise de volume, origem e comportamento anormal do tráfego.' },
                { icon: Zap, step: '02', title: 'Conter', description: 'Filtros, bloqueios e limitação de rotas para reduzir o impacto.' },
                { icon: ShieldCheck, step: '03', title: 'Isolar', description: 'Separação do serviço afetado quando necessária para proteger a rede.' },
              ].map(({ icon: Icon, step, title, description }) => (
                <article key={step} className="plan-command-card rounded-2xl border p-5">
                  <div className="flex items-center justify-between"><span className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent"><Icon className="h-5 w-5" /></span><span className="font-mono text-xs font-bold text-accent/45">{step}</span></div>
                  <h3 className="mt-5 text-lg font-semibold text-text">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-text-muted">{description}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {['DoS e DDoS', 'Tentativas de invasão', 'IP spoofing', 'Scans abusivos'].map((threat) => (
              <div key={threat} className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3 text-sm font-medium text-text-muted"><ShieldAlert className="h-4 w-4 shrink-0 text-accent" />{threat}</div>
            ))}
          </div>
        </section>

        <section id="reembolsos" className="scroll-mt-28 border-b border-white/8 py-20">
          <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <span className="font-mono text-[0.68rem] font-bold tracking-[0.18em] text-accent uppercase">03 · Reembolsos</span>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-text sm:text-4xl">Um processo simples e registrado.</h2>
              <p className="mt-4 max-w-2xl text-base leading-7 text-text-muted">
                Em contratações realizadas online, o consumidor pode exercer o direito de arrependimento em até <strong className="font-semibold text-text">7 dias corridos</strong>, contados da assinatura ou ativação do serviço, conforme a legislação aplicável.
              </p>

              <div className="mt-8 space-y-3">
                {refundSteps.map((step) => (
                  <div key={step.number} className="flex gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
                    <span className="font-mono text-sm font-bold text-accent">{step.number}</span>
                    <div><h3 className="font-semibold text-text">{step.title}</h3><p className="mt-1 text-sm leading-6 text-text-muted">{step.description}</p></div>
                  </div>
                ))}
              </div>
            </div>

            <aside className="rounded-2xl border border-accent/20 bg-accent/[0.055] p-5 sm:p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent"><ReceiptText className="h-5 w-5" /></span>
                <div><p className="text-[0.62rem] font-bold tracking-[0.16em] text-accent uppercase">Antes de solicitar</p><h3 className="text-lg font-semibold text-text">O que você precisa saber</h3></div>
              </div>
              <ul className="mt-6 space-y-4 text-sm leading-6 text-text-muted">
                <li className="flex gap-2.5"><Check className="mt-1 h-4 w-4 shrink-0 text-ok" />Dentro do prazo legal, o pedido de arrependimento não exige justificativa.</li>
                <li className="flex gap-2.5"><Check className="mt-1 h-4 w-4 shrink-0 text-ok" />Depois que o estorno é iniciado, o crédito pode levar o prazo definido pelo provedor, bandeira ou banco.</li>
                <li className="flex gap-2.5"><Check className="mt-1 h-4 w-4 shrink-0 text-ok" />Faça uma cópia dos seus arquivos antes do encerramento; o acesso aos dados pode ser perdido após o cancelamento.</li>
                <li className="flex gap-2.5"><Check className="mt-1 h-4 w-4 shrink-0 text-ok" />Falhas do serviço ou cobranças incorretas podem ser analisadas a qualquer momento, sem prejuízo dos direitos previstos em lei.</li>
              </ul>
              <CopySupportEmail label="Copiar e-mail para solicitar" className="mt-7 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-contrast transition-all hover:-translate-y-0.5 hover:bg-accent-strong" />
            </aside>
          </div>
        </section>

        <section id="suporte" className="scroll-mt-28 py-20">
          <div className="trust-support-card relative overflow-hidden rounded-3xl border border-white/10 p-6 sm:p-9">
            <div className="relative grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
              <div>
                <span className="font-mono text-[0.68rem] font-bold tracking-[0.18em] text-accent uppercase">04 · Suporte</span>
                <h2 className="mt-3 text-3xl font-bold tracking-tight text-text sm:text-4xl">Fale com uma pessoa, pelo canal oficial.</h2>
                <p className="mt-4 max-w-2xl text-base leading-7 text-text-muted">Use o e-mail cadastrado na sua conta e envie o máximo de contexto possível. As mensagens são atendidas por ordem de chegada e ficam registradas para acompanhamento.</p>

                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  <p className="flex items-center gap-2.5 text-sm text-text-muted"><FileCheck2 className="h-4 w-4 text-accent" />Informe o servidor ou número do pedido</p>
                  <p className="flex items-center gap-2.5 text-sm text-text-muted"><MessageSquareText className="h-4 w-4 text-accent" />Descreva o problema e quando começou</p>
                  <p className="flex items-center gap-2.5 text-sm text-text-muted"><ShieldCheck className="h-4 w-4 text-accent" />Nunca envie senha ou dados do cartão</p>
                  <p className="flex items-center gap-2.5 text-sm text-text-muted"><Sparkles className="h-4 w-4 text-accent" />Anexe imagens quando ajudarem no diagnóstico</p>
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/20 p-5 text-center backdrop-blur-sm sm:min-w-80">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent"><Mail className="h-5 w-5" /></span>
                <p className="mt-4 text-[0.62rem] font-bold tracking-[0.16em] text-text-faint uppercase">E-mail oficial</p>
                <CopySupportEmail icon="none" className="mt-1 text-lg font-semibold text-text transition-colors hover:text-accent" />
                <CopySupportEmail label="Copiar e-mail" className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.055] px-4 text-sm font-semibold text-text transition-all hover:border-accent/30 hover:bg-accent/10 hover:text-accent" />
              </div>
            </div>
          </div>
        </section>

        <p className="mx-auto max-w-3xl text-center text-xs leading-5 text-text-faint">Esta Central apresenta o funcionamento operacional da GXhost e não limita direitos garantidos pela legislação brasileira. A política poderá ser aprimorada conforme novos canais e recursos forem disponibilizados.</p>
      </div>
    </div>
  );
}
