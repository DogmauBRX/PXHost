import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  FileText,
  Gavel,
  LockKeyhole,
  Mail,
  Network,
  ShieldCheck,
} from 'lucide-react';
import { HeroCircuitBackground } from './HeroCircuitBackground';
import { Seo } from './Seo';

const SUPPORT_EMAIL = 'gxhostbr@gmail.com';

const prohibitedActivities = [
  'Invasão, tentativa de invasão, exploração de vulnerabilidades ou acesso não autorizado a sistemas, contas, dispositivos ou redes.',
  'Ataques de negação de serviço (DoS/DDoS), participação em botnets, amplificação de tráfego ou qualquer ação destinada a indisponibilizar serviços.',
  'IP spoofing, falsificação de origem, manipulação de identidade de rede ou tentativa de ocultar a autoria de atividade abusiva.',
  'Varredura de portas, protocolos, serviços ou vulnerabilidades sem autorização expressa do responsável pelo alvo.',
  'Distribuição de malware, phishing, roubo de credenciais, spam, fraude ou qualquer prática definida como ilícita pela legislação aplicável.',
];

const sections = [
  { id: 'aceitacao', number: '01', label: 'Aceitação e escopo' },
  { id: 'responsabilidade', number: '02', label: 'Responsabilidade do cliente' },
  { id: 'medidas', number: '03', label: 'Medidas de proteção' },
  { id: 'financeiro', number: '04', label: 'Pagamentos e reembolsos' },
  { id: 'dados', number: '05', label: 'Dados e backups' },
  { id: 'suporte', number: '06', label: 'Suporte e alterações' },
];

export function TermsPage() {
  return (
    <div className="plans-command relative min-h-screen overflow-hidden">
      <Seo
        title="Termos de Uso"
        description="Regras de uso, segurança, pagamentos e responsabilidades aplicáveis aos serviços GXhost."
        path="/termos"
      />

      <HeroCircuitBackground className="plans-command__circuit pointer-events-none absolute inset-x-0 top-0 h-[40rem] w-full" />
      <div className="plans-command__glow" aria-hidden="true" />

      <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <header className="mx-auto max-w-4xl text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 font-mono text-[0.68rem] font-semibold tracking-[0.16em] text-accent uppercase">
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            Termos de uso · versão 1.0
          </div>
          <h1 className="text-4xl leading-tight font-bold tracking-[-0.04em] text-text sm:text-5xl lg:text-6xl">
            Uso responsável. <span className="plans-accent-text">Proteção para todos.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-text-muted sm:text-lg">Estas regras protegem a infraestrutura, os clientes e terceiros. Ao contratar ou utilizar a GXhost, você declara que leu e concorda com estes termos.</p>
          <p className="mt-4 font-mono text-[0.65rem] tracking-wider text-text-faint uppercase">Atualizado em 20 de setembro de 2026</p>
        </header>

        <div className="mt-12 grid gap-8 lg:grid-cols-[17rem_1fr] lg:items-start">
          <aside className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 lg:sticky lg:top-28">
            <p className="mb-3 px-2 text-[0.62rem] font-bold tracking-[0.18em] text-text-faint uppercase">Neste documento</p>
            <nav className="space-y-1" aria-label="Seções dos termos">
              {sections.map((section) => (
                <a key={section.id} href={`#${section.id}`} className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-text-muted transition-colors hover:bg-white/5 hover:text-text">
                  <span className="font-mono text-[0.62rem] font-bold text-accent/65">{section.number}</span>
                  {section.label}
                </a>
              ))}
            </nav>
            <div className="mt-4 border-t border-white/8 px-2 pt-4">
              <p className="text-xs leading-5 text-text-faint">Dúvidas sobre estes termos?</p>
              <a href={`mailto:${SUPPORT_EMAIL}?subject=Dúvida%20sobre%20os%20Termos%20GXhost`} className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:text-accent-strong"><Mail className="h-3.5 w-3.5" />{SUPPORT_EMAIL}</a>
            </div>
          </aside>

          <main className="space-y-5">
            <section id="aceitacao" className="scroll-mt-28 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-7">
              <TermHeading number="01" title="Aceitação e escopo" icon={ShieldCheck} />
              <div className="mt-5 space-y-4 text-sm leading-7 text-text-muted">
                <p>Estes Termos de Uso regulam a contratação e utilização dos serviços de hospedagem, painel de controle e recursos associados fornecidos pela GXhost.</p>
                <p>O cliente deve fornecer dados verdadeiros, manter as credenciais seguras e utilizar os recursos dentro do plano contratado. O acesso à conta é pessoal, e o titular responde pelas ações realizadas por usuários aos quais conceder permissão.</p>
                <p>As regras são aplicáveis sem prejuízo do Código de Defesa do Consumidor, do Marco Civil da Internet e das demais normas brasileiras obrigatórias.</p>
              </div>
            </section>

            <section id="responsabilidade" className="scroll-mt-28 rounded-2xl border border-red-400/15 bg-red-400/[0.025] p-5 sm:p-7">
              <TermHeading number="02" title="Responsabilidade do cliente" icon={AlertTriangle} danger />
              <p className="mt-5 text-sm leading-7 text-text-muted">É proibido utilizar, direta ou indiretamente, a infraestrutura GXhost para cybercrime, ataques, testes não autorizados ou qualquer atividade que prejudique terceiros. Isso inclui:</p>
              <ul className="mt-5 space-y-3">
                {prohibitedActivities.map((activity) => (
                  <li key={activity} className="flex gap-3 rounded-xl border border-white/[0.06] bg-black/10 p-3.5 text-sm leading-6 text-text-muted">
                    <AlertTriangle className="mt-1 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
                    {activity}
                  </li>
                ))}
              </ul>

              <div className="mt-6 rounded-xl border border-ok/15 bg-ok/[0.045] p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-text"><Network className="h-4 w-4 text-ok" />Uso de VPN é permitido</div>
                <p className="mt-2 text-sm leading-6 text-text-muted">VPN, proxy e túneis de rede podem ser utilizados para fins legítimos. Eles não podem ocultar, facilitar ou transportar qualquer uma das atividades proibidas acima.</p>
              </div>
            </section>

            <section id="medidas" className="scroll-mt-28 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-7">
              <TermHeading number="03" title="Medidas de proteção e consequências" icon={LockKeyhole} />
              <div className="mt-5 space-y-4 text-sm leading-7 text-text-muted">
                <p>Ao detectar indícios de abuso, a GXhost poderá filtrar tráfego, bloquear conexões, isolar o servidor ou suspender temporariamente o serviço para conter riscos e preservar a infraestrutura.</p>
                <p>Quando houver evidência de infração grave ou reincidente, o serviço poderá ser cancelado sem possibilidade de reativação. A violação não gera direito contratual a reembolso do período remanescente, <strong className="font-semibold text-text">ressalvados os direitos e restituições obrigatórios previstos em lei</strong>.</p>
                <p>A GXhost poderá preservar registros relacionados ao incidente e adotar medidas administrativas ou judiciais cabíveis, inclusive cooperar com autoridades competentes, sempre dentro da legislação e das regras de proteção de dados.</p>
                <p>O cliente poderá solicitar esclarecimentos ou contestar uma medida pelo e-mail oficial de suporte, apresentando as informações relevantes para análise.</p>
              </div>
            </section>

            <section id="financeiro" className="scroll-mt-28 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-7">
              <TermHeading number="04" title="Pagamentos, renovação e reembolsos" icon={Gavel} />
              <div className="mt-5 space-y-4 text-sm leading-7 text-text-muted">
                <p>Os preços, a periodicidade e o método de pagamento são informados antes da confirmação. O Pix exige uma nova cobrança a cada ciclo; no cartão, a renovação é recorrente até o cancelamento da assinatura.</p>
                <p>Contratações online observam o direito de arrependimento e as demais garantias legais. O fluxo de solicitação, processamento e prazos está detalhado na Central GX.</p>
              </div>
              <Link to="/central" hash="reembolsos" className="group mt-5 inline-flex items-center gap-2 rounded-xl border border-accent/20 bg-accent/10 px-4 py-2.5 text-sm font-semibold text-accent transition-all hover:border-accent/35 hover:bg-accent/15">
                Consultar política de reembolso
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </section>

            <section id="dados" className="scroll-mt-28 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-7">
              <TermHeading number="05" title="Dados, arquivos e backups" icon={LockKeyhole} />
              <div className="mt-5 space-y-4 text-sm leading-7 text-text-muted">
                <p>O cliente é responsável pelo conteúdo hospedado e por manter cópias atualizadas dos dados importantes fora do servidor. Backups oferecidos no painel são uma camada adicional e não substituem uma estratégia própria de recuperação.</p>
                <p>O encerramento ou cancelamento pode tornar arquivos e bancos de dados indisponíveis. Exporte os dados necessários antes de concluir o cancelamento.</p>
                <p>Credenciais, dados pessoais e registros são tratados conforme a legislação aplicável. Nunca compartilhe senhas ou dados completos de cartão com o suporte.</p>
              </div>
            </section>

            <section id="suporte" className="scroll-mt-28 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-7">
              <TermHeading number="06" title="Suporte, comunicação e alterações" icon={Mail} />
              <div className="mt-5 space-y-4 text-sm leading-7 text-text-muted">
                <p>O canal oficial de suporte é <a href={`mailto:${SUPPORT_EMAIL}`} className="font-semibold text-accent hover:text-accent-strong">{SUPPORT_EMAIL}</a>. Para facilitar a análise, utilize o e-mail cadastrado e informe o servidor ou pedido relacionado.</p>
                <p>Estes termos poderão ser atualizados para refletir mudanças legais, operacionais ou de segurança. A versão e a data de atualização permanecerão identificadas nesta página.</p>
              </div>
            </section>

            <div className="flex items-start gap-3 rounded-2xl border border-accent/15 bg-accent/[0.045] p-5 text-sm leading-6 text-text-muted">
              <Check className="mt-1 h-4 w-4 shrink-0 text-ok" aria-hidden="true" />
              <p>Ao continuar utilizando os serviços após uma atualização, o cliente concorda com a versão vigente, sem que isso limite direitos garantidos pela legislação brasileira.</p>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function TermHeading({ number, title, icon: Icon, danger = false }: { number: string; title: string; icon: typeof ShieldCheck; danger?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`flex h-10 w-10 items-center justify-center rounded-xl border ${danger ? 'border-red-400/20 bg-red-400/10 text-red-300' : 'border-accent/20 bg-accent/10 text-accent'}`}>
        <Icon className="h-4.5 w-4.5" aria-hidden="true" />
      </span>
      <div>
        <p className={`font-mono text-[0.62rem] font-bold tracking-[0.16em] uppercase ${danger ? 'text-red-300/80' : 'text-accent/75'}`}>{number} · Termos GX</p>
        <h2 className="text-xl font-semibold text-text sm:text-2xl">{title}</h2>
      </div>
    </div>
  );
}
