import { ExternalLink, LifeBuoy, Mail, ShieldCheck } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { PageHeader } from '@/ui/primitives';

export function SupportPage() {
  return (
    <>
      <PageHeader title="Suporte" subtitle="Fale com a equipe pelo canal oficial da GXhost." />

      <div className="grid gap-4 lg:grid-cols-[1fr_0.8fr]">
        <section className="support-command-card rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
            <LifeBuoy className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-xl font-semibold text-text">Atendimento por e-mail</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-text-muted">Envie a mensagem usando o e-mail cadastrado na sua conta. Inclua o nome do servidor ou número do pedido e descreva o que aconteceu.</p>

          <a href="mailto:gxhostbr@gmail.com?subject=Suporte%20GXhost" className="mt-6 flex w-fit items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-contrast transition-all hover:-translate-y-0.5 hover:bg-accent-strong">
            <Mail className="h-4 w-4" aria-hidden="true" />
            gxhostbr@gmail.com
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </section>

        <aside className="support-security-card rounded-2xl border border-border bg-surface-2 p-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-text"><ShieldCheck className="h-4 w-4 text-ok" />Sua segurança primeiro</div>
          <p className="mt-3 text-sm leading-6 text-text-muted">Nunca envie sua senha, códigos de acesso ou dados do cartão. A equipe poderá solicitar apenas informações para localizar sua conta e diagnosticar o serviço.</p>
          <Link to="/central" hash="suporte" className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:text-accent-strong">
            Ver orientações de suporte
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </aside>
      </div>
    </>
  );
}
