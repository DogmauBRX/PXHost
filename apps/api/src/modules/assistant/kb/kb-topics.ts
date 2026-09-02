import type { AssistantBlock, AssistantContext, AssistantRoute } from '../assistant.types';

export interface KbTopic {
  id: string;
  title: string;
  /** PT-BR phrases fed to kb-matcher's scorer — not exact strings the user must type, just representative vocabulary. */
  keywords: string[];
  /**
   * The mechanism that makes an incompatible answer structurally
   * impossible rather than merely unlikely: a topic whose `requires`
   * returns false is not a candidate at all, the same way a route that
   * doesn't exist can't be navigated to. `addons.install.plugins` on a
   * Fabric server isn't "unlikely to match" — it's never in the pool.
   */
  requires?: (ctx: AssistantContext) => boolean;
  /** Enforced by assistant.spec.ts, not convention: every destructive topic's render() MUST include a `note` block with tone 'warn'. */
  destructive?: boolean;
  render(ctx: AssistantContext): AssistantBlock[];
}

function formatRange(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null;
  if (min != null && max == null) return `${min}+`;
  if (min == null && max != null) return `até ${max}`;
  return `${min}–${max}`;
}

const link = (route: AssistantRoute, label: string): AssistantBlock => ({ type: 'link', route, label });

export const KB_TOPICS: KbTopic[] = [
  {
    id: 'server.create',
    title: 'Como crio um novo servidor?',
    keywords: ['criar servidor', 'novo servidor', 'comprar servidor', 'contratar servidor'],
    render: () => [
      { type: 'text', text: 'Hoje a criação de servidores é feita pela nossa equipe, não diretamente pelo painel do cliente.' },
      link('client.support', 'Falar com o suporte'),
    ],
  },
  {
    id: 'server.start',
    title: 'Como inicio o servidor?',
    keywords: ['iniciar servidor', 'startar servidor', 'ligar servidor', 'colocar no ar'],
    render: (ctx) => [
      { type: 'text', text: `Vá até o Console de "${ctx.serverName}" e clique em "Iniciar". O status muda para "Iniciando" e depois "Online" — pode levar de alguns segundos a poucos minutos, dependendo dos mods/plugins instalados.` },
      link('server.console', 'Abrir o Console'),
    ],
  },
  {
    id: 'server.stop',
    title: 'Como paro o servidor?',
    keywords: ['parar servidor', 'desligar servidor', 'encerrar servidor'],
    render: (ctx) => [
      { type: 'text', text: `No Console de "${ctx.serverName}", clique em "Parar" para um desligamento limpo (salva o mundo antes de encerrar). Use "Forçar parada" só se o servidor estiver travado — ela não salva o progresso.` },
      { type: 'note', tone: 'warn', text: '"Forçar parada" pode causar perda de progresso não salvo.' },
      link('server.console', 'Abrir o Console'),
    ],
  },
  {
    id: 'addons.install.plugins',
    title: 'Como instalo plugins?',
    keywords: ['instalar plugin', 'adicionar plugin', 'colocar plugin', 'plugin novo'],
    requires: (ctx) => ctx.software.addonNoun === 'plugin',
    render: (ctx) => [
      { type: 'text', text: `${ctx.software.label} carrega plugins da pasta ${ctx.software.addonDirDisplay}. Envie o arquivo .jar do plugin na aba "${ctx.software.addonLabel}" e reinicie o servidor para ele ser carregado.` },
      { type: 'steps', items: [`Abra a aba "${ctx.software.addonLabel}"`, 'Clique em "Enviar arquivo"', 'Escolha o .jar do plugin', 'Reinicie o servidor'] },
      link('server.addons', `Abrir ${ctx.software.addonLabel ?? 'Add-ons'}`),
    ],
  },
  {
    id: 'addons.install.mods',
    title: 'Como instalo mods?',
    keywords: ['instalar mod', 'adicionar mod', 'colocar mod', 'mod novo'],
    requires: (ctx) => ctx.software.addonNoun === 'mod',
    render: (ctx) => [
      { type: 'text', text: `${ctx.software.label} carrega mods da pasta ${ctx.software.addonDirDisplay}. Envie o arquivo .jar do mod na aba "${ctx.software.addonLabel}" e reinicie o servidor para ele ser carregado.` },
      { type: 'steps', items: [`Abra a aba "${ctx.software.addonLabel}"`, 'Clique em "Enviar arquivo"', 'Escolha o .jar do mod', 'Reinicie o servidor'] },
      link('server.addons', `Abrir ${ctx.software.addonLabel ?? 'Add-ons'}`),
    ],
  },
  {
    id: 'addons.unsupported',
    title: 'Posso instalar mods ou plugins neste servidor?',
    keywords: ['instalar plugin', 'instalar mod', 'adicionar mod', 'adicionar plugin'],
    requires: (ctx) => !ctx.software.addonDir,
    render: (ctx) => [
      { type: 'text', text: `${ctx.software.label} não usa mods nem plugins, então não há pasta de add-ons para este servidor.` },
    ],
  },
  {
    id: 'software.change',
    title: 'Como troco para Fabric, Forge ou outro software?',
    keywords: ['instalar fabric', 'instalar forge', 'trocar software', 'mudar de paper para forge', 'trocar servidor de mods'],
    render: () => [
      { type: 'text', text: 'O software do servidor (Paper, Fabric, Forge etc.) é definido na criação e não pode ser trocado sozinho pelo painel — isso exigiria recriar o servidor do zero.' },
      link('client.support', 'Falar com o suporte'),
    ],
  },
  {
    id: 'minecraft.version.change',
    title: 'Como troco a versão do Minecraft?',
    keywords: ['trocar versao', 'mudar versao do minecraft', 'atualizar minecraft', 'versao do jogo'],
    requires: (ctx) => ctx.permissions.includes('startup.read'),
    destructive: true,
    render: (ctx) => [
      { type: 'text', text: 'A versão do Minecraft é uma variável de inicialização, editável na aba Configurações — mas só com o servidor parado.' },
      { type: 'steps', items: ['Pare o servidor', 'Abra a aba Configurações', 'Edite "Minecraft Version"', 'Salve — o servidor será recriado com a nova versão', 'Inicie o servidor novamente'] },
      { type: 'note', tone: 'warn', text: 'Faça um backup antes de trocar de versão — algumas atualizações não são compatíveis com mundos/mods antigos.' },
      link('server.variables', 'Abrir Configurações'),
    ],
  },
  {
    id: 'files.ftp',
    title: 'Tem acesso por FTP?',
    keywords: ['ftp', 'sftp', 'filezilla', 'acesso ftp'],
    render: () => [
      { type: 'text', text: 'Ainda não oferecemos acesso via FTP/SFTP. O gerenciador de arquivos do painel cobre upload, download, edição e organização de arquivos — inclusive de múltiplos arquivos de uma vez.' },
      link('server.files', 'Abrir Arquivos'),
    ],
  },
  {
    id: 'files.manage',
    title: 'Como envio ou edito arquivos do servidor?',
    keywords: ['enviar arquivo', 'upload de arquivo', 'editar arquivo', 'gerenciador de arquivos', 'baixar arquivo'],
    requires: (ctx) => ctx.permissions.includes('file.read'),
    render: () => [
      { type: 'text', text: 'A aba Arquivos permite navegar, enviar, baixar, renomear, editar e excluir arquivos do servidor, além de compactar/extrair .zip.' },
      link('server.files', 'Abrir Arquivos'),
    ],
  },
  {
    id: 'backup.create',
    title: 'Como faço um backup?',
    keywords: ['fazer backup', 'criar backup', 'salvar backup'],
    requires: (ctx) => ctx.permissions.includes('backup.create'),
    render: () => [
      { type: 'text', text: 'Na aba Backups, clique em "Criar backup". Ele roda em segundo plano e aparece na lista quando terminar.' },
      link('server.backups', 'Abrir Backups'),
    ],
  },
  {
    id: 'backup.restore',
    title: 'Como restauro um backup?',
    keywords: ['restaurar backup', 'voltar backup', 'recuperar backup'],
    requires: (ctx) => ctx.permissions.includes('backup.restore'),
    destructive: true,
    render: () => [
      { type: 'text', text: 'Na aba Backups, escolha o backup desejado e clique em "Restaurar".' },
      { type: 'note', tone: 'warn', text: 'Restaurar substitui os arquivos atuais do servidor pelos do backup — o que não estiver no backup será perdido.' },
      link('server.backups', 'Abrir Backups'),
    ],
  },
  {
    id: 'ram.configure',
    title: 'Como configuro a RAM do servidor?',
    keywords: ['configurar ram', 'aumentar ram', 'memoria do servidor', 'mudar memoria'],
    render: (ctx) => [
      { type: 'text', text: `A RAM do servidor (hoje ${ctx.memoryMb} MB) vem do plano contratado, não é editável diretamente. Para aumentar, faça upgrade de plano.` },
      link('client.plan', 'Ver planos'),
    ],
  },
  {
    id: 'console.errors',
    title: 'Como leio erros no console?',
    keywords: ['erro no console', 'servidor travou', 'crash', 'log de erro', 'nao inicia'],
    render: (ctx) => [
      { type: 'text', text: 'O Console mostra a saída em tempo real do servidor, incluindo erros. Procure por linhas com "ERROR", "Exception" ou "OutOfMemory" perto do momento da falha.' },
      { type: 'steps', items: ['"OutOfMemoryError" costuma indicar RAM insuficiente para os mods/plugins instalados', 'Um erro logo após instalar um mod/plugin geralmente aponta para ele', 'Erros de "port already in use" ou de conexão indicam problema de alocação — fale com o suporte'] },
      link('server.console', 'Abrir o Console'),
    ],
  },
  {
    id: 'server.connect',
    title: 'Como conecto no servidor / qual é o IP?',
    keywords: ['conectar no servidor', 'ip do servidor', 'endereco do servidor', 'porta do servidor', 'como entrar no servidor'],
    render: (ctx) => {
      if (!ctx.primaryAllocation) {
        return [{ type: 'text', text: 'Este servidor ainda não tem um endereço alocado.' }];
      }
      const address = ctx.primaryAllocation.port === 25565 ? ctx.primaryAllocation.ip : `${ctx.primaryAllocation.ip}:${ctx.primaryAllocation.port}`;
      return [
        { type: 'text', text: 'No Minecraft, vá em "Multiplayer" → "Add Server" e use o endereço abaixo.' },
        { type: 'kv', items: [{ label: 'Endereço', value: address }] },
      ];
    },
  },
  {
    id: 'operators.add',
    title: 'Como adiciono operadores (OP)?',
    keywords: ['adicionar operador', 'dar op', 'op no jogador', 'admin no servidor'],
    requires: (ctx) => ctx.permissions.includes('control.console'),
    render: () => [
      { type: 'text', text: 'No Console, com o servidor rodando, digite o comando abaixo trocando pelo nome do jogador.' },
      { type: 'code', language: 'text', code: 'op NomeDoJogador' },
      link('server.console', 'Abrir o Console'),
    ],
  },
  {
    id: 'settings.general',
    title: 'Como altero as configurações do servidor?',
    keywords: ['alterar configuracoes', 'mudar configuracao', 'editar variaveis', 'configuracoes do servidor'],
    requires: (ctx) => ctx.permissions.includes('startup.read'),
    render: () => [
      { type: 'text', text: 'A aba Configurações lista as variáveis de inicialização editáveis do servidor. Alterar qualquer valor exige que o servidor esteja parado, pois ele é recriado com os novos valores.' },
      link('server.variables', 'Abrir Configurações'),
    ],
  },
  {
    id: 'players.recommended',
    title: 'Quantos jogadores meu plano aguenta?',
    keywords: ['quantos jogadores', 'limite de jogadores', 'jogadores simultaneos', 'plano aguenta'],
    render: (ctx) => {
      const range = ctx.plan ? formatRange(ctx.plan.recommendedPlayersMin, ctx.plan.recommendedPlayersMax) : null;
      if (!range) {
        return [{ type: 'text', text: 'Não temos uma recomendação de jogadores publicada para este plano.' }];
      }
      return [
        { type: 'text', text: `O plano "${ctx.plan!.name}" recomenda aproximadamente ${range} jogadores simultâneos. É uma recomendação, não um limite técnico rígido — depende também dos mods/plugins instalados.` },
        link('client.plan', 'Ver planos'),
      ];
    },
  },
  {
    id: 'addons.recommended',
    title: 'Quantos mods ou plugins meu plano aguenta?',
    keywords: ['quantos mods', 'quantos plugins', 'limite de mods', 'limite de plugins'],
    requires: (ctx) => !!ctx.software.addonDir,
    render: (ctx) => {
      if (!ctx.plan) return [{ type: 'text', text: 'Não temos uma recomendação publicada para este plano.' }];
      const range = ctx.software.addonNoun === 'mod'
        ? formatRange(ctx.plan.recommendedModsMin, ctx.plan.recommendedModsMax)
        : formatRange(ctx.plan.recommendedPluginsMin, ctx.plan.recommendedPluginsMax);
      if (!range) return [{ type: 'text', text: 'Não temos uma recomendação publicada para este plano.' }];
      return [
        { type: 'text', text: `O plano "${ctx.plan.name}" recomenda aproximadamente ${range} ${ctx.software.addonNoun === 'mod' ? 'mods' : 'plugins'}. É uma recomendação, não um limite técnico — depende do peso de cada um.` },
        link('client.plan', 'Ver planos'),
      ];
    },
  },
  {
    id: 'resource.alerts',
    title: 'O que significa o alerta de uso de recursos?',
    keywords: ['alerta de memoria', 'uso de recursos', 'servidor lento', 'aviso de ram alta'],
    render: (ctx) => [
      { type: 'text', text: 'O aviso aparece quando o servidor sustenta uso muito alto de memória ou CPU por um período — sinal de que ele pode ficar lento ou travar.' },
      { type: 'steps', items: ['Reduza a quantidade de mods/plugins ou jogadores simultâneos', 'Otimize configurações pesadas (view-distance, mobs, etc.)', 'Considere um upgrade de plano se o uso for consistente'] },
      link('client.plan', 'Ver planos'),
    ],
  },
  {
    id: 'plan.upgrade',
    title: 'Como faço upgrade do meu plano?',
    keywords: ['upgrade de plano', 'mudar de plano', 'aumentar plano', 'plano maior'],
    render: () => [
      { type: 'text', text: 'A página Plano mostra o plano atual e todos os planos disponíveis para comparação e upgrade.' },
      link('client.plan', 'Ver planos'),
    ],
  },
];
