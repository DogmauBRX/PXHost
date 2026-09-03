import { KnowledgeBaseProvider } from './kb-provider';
import { KB_TOPICS } from './kb-topics';
import { describeSoftware } from '../../templates/software';
import type { AssistantContext } from '../assistant.types';

function makeContext(overrides: Partial<AssistantContext> = {}): AssistantContext {
  return {
    serverName: 'Servidor de Teste',
    memoryMb: 2048,
    diskMb: 10240,
    status: 'active',
    powerState: 'running',
    software: describeSoftware('paper'),
    plan: {
      name: 'Intermediário',
      recommendedPlayersMin: 15,
      recommendedPlayersMax: 30,
      recommendedModsMin: null,
      recommendedModsMax: null,
      recommendedPluginsMin: 30,
      recommendedPluginsMax: 80,
    },
    primaryAllocation: { ip: '203.0.113.10', port: 25565 },
    permissions: [
      'server.read', 'startup.read', 'startup.update', 'file.read', 'file.write', 'file.delete',
      'backup.read', 'backup.create', 'backup.restore', 'control.console', 'control.start', 'control.stop',
    ],
    ...overrides,
  };
}

describe('KnowledgeBaseProvider', () => {
  const provider = new KnowledgeBaseProvider();

  it('never offers addons.install.plugins on a Fabric (mods-only) server, for any message', async () => {
    const ctx = makeContext({ software: describeSoftware('fabric') });

    const suggestionIds = provider.suggestions(ctx).map((s) => s.topicId);
    expect(suggestionIds).not.toContain('addons.install.plugins');

    const reply = await provider.reply('quero instalar plugins no meu servidor', [], ctx);
    expect(reply.topicId).not.toBe('addons.install.plugins');
  });

  it('never offers addons.install.mods on a Paper (plugins-only) server', async () => {
    const ctx = makeContext({ software: describeSoftware('paper') });

    const suggestionIds = provider.suggestions(ctx).map((s) => s.topicId);
    expect(suggestionIds).not.toContain('addons.install.mods');

    const reply = await provider.reply('quero instalar mods no meu servidor', [], ctx);
    expect(reply.topicId).not.toBe('addons.install.mods');
  });

  it('routes a vanilla server to the addons.unsupported topic instead of install.mods/plugins', async () => {
    const ctx = makeContext({ software: describeSoftware('vanilla') });
    const suggestionIds = provider.suggestions(ctx).map((s) => s.topicId);
    expect(suggestionIds).toContain('addons.unsupported');
    expect(suggestionIds).not.toContain('addons.install.mods');
    expect(suggestionIds).not.toContain('addons.install.plugins');
  });

  it('every topic marked destructive emits at least one warn-tone note block', () => {
    const ctx = makeContext();
    const destructiveTopics = KB_TOPICS.filter((t) => t.destructive);
    expect(destructiveTopics.length).toBeGreaterThan(0);

    for (const topic of destructiveTopics) {
      if (topic.requires && !topic.requires(ctx)) continue; // not applicable to this fixture's context
      const blocks = topic.render(ctx);
      const hasWarning = blocks.some((b) => b.type === 'note' && b.tone === 'warn');
      expect(hasWarning).toBe(true);
    }
  });

  it('falls back with low confidence and suggestions on unrecognized input', async () => {
    const ctx = makeContext();
    const reply = await provider.reply('xyzzy plugh qwerty asdf', [], ctx);
    expect(reply.confident).toBe(false);
    expect(reply.topicId).toBeUndefined();
    const stepsBlock = reply.blocks.find((b) => b.type === 'steps');
    expect(stepsBlock).toBeDefined();
  });

  it.each([
    ['como eu inicio o servidor', 'server.start'],
    ['como parar o servidor', 'server.stop'],
    ['quero fazer backup', 'backup.create'],
    ['como restauro um backup', 'backup.restore'],
    ['qual o ip do servidor', 'server.connect'],
    ['como dou op para um jogador', 'operators.add'],
    ['voces tem ftp', 'files.ftp'],
    ['quero aumentar a ram', 'ram.configure'],
  ])('matches %j to topic %j', async (message, expectedTopicId) => {
    const ctx = makeContext();
    const reply = await provider.reply(message, [], ctx);
    expect(reply.topicId).toBe(expectedTopicId);
  });

  it('every KB topic id is unique', () => {
    const ids = KB_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
