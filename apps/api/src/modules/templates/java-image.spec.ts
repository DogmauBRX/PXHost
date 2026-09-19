import { pickDockerImage, requiredJavaMajor, SOFTWARE_PRESETS } from './software-presets';

describe('escolha da imagem Java por versão do Minecraft', () => {
  describe('requiredJavaMajor', () => {
    it.each([
      ['1.8.9', 8],
      ['1.12.2', 8],
      ['1.16.5', 8],
      ['1.17', 17],
      ['1.17.1', 17],
      ['1.18.2', 17],
      ['1.19.4', 17],
      ['1.20', 17],
      ['1.20.1', 17],
      ['1.20.4', 17],
    ])('%s -> Java %i', (versao, esperado) => {
      expect(requiredJavaMajor(versao)).toBe(esperado);
    });

    // 1.20.5 é a fronteira real da Mojang: .4 ainda é 17, .5 já é 21.
    it.each([
      ['1.20.5', 21],
      ['1.20.6', 21],
      ['1.21', 21],
      ['1.21.11', 21],
    ])('%s -> Java %i', (versao, esperado) => {
      expect(requiredJavaMajor(versao)).toBe(esperado);
    });

    it('versões do esquema por ano (26.x) usam a JRE mais nova', () => {
      expect(requiredJavaMajor('26.1')).toBe(25);
      expect(requiredJavaMajor('26.3')).toBe(25);
    });

    it('devolve null para o que não dá para interpretar, em vez de chutar', () => {
      for (const entrada of ['latest', '', '25w14a', 'abc', '1.x']) {
        expect(requiredJavaMajor(entrada)).toBeNull();
      }
    });
  });

  describe('pickDockerImage', () => {
    const imagens = {
      'Java 8': 'ghcr.io/pterodactyl/yolks:java_8',
      'Java 17': 'ghcr.io/pterodactyl/yolks:java_17',
      'Java 21': 'ghcr.io/pterodactyl/yolks:java_21',
      'Java 25': 'ghcr.io/pterodactyl/yolks:java_25',
    };

    // O caso real que originou isto: um modpack Cobblemon de 1.20.1 rodando
    // em java_25 morria carregando os mods com NoSuchMethodError em
    // sun.misc.Unsafe.ensureClassInitialized.
    it('1.20.1 recebe Java 17, não a JRE mais nova', () => {
      expect(pickDockerImage(imagens, '1.20.1')).toBe('ghcr.io/pterodactyl/yolks:java_17');
    });

    it('1.21.1 recebe Java 21', () => {
      expect(pickDockerImage(imagens, '1.21.1')).toBe('ghcr.io/pterodactyl/yolks:java_21');
    });

    it('26.3 recebe Java 25', () => {
      expect(pickDockerImage(imagens, '26.3')).toBe('ghcr.io/pterodactyl/yolks:java_25');
    });

    // "latest" é o valor PADRÃO de MINECRAFT_VERSION nos presets e quer
    // dizer a versão mais nova — resolver para a JRE mais antiga do mapa
    // (Java 8, que ordena primeiro) quebraria praticamente todo servidor
    // moderno. Foi o que a primeira versão desta função fazia.
    it('versão desconhecida cai na imagem MAIS NOVA, nunca na primeira', () => {
      expect(pickDockerImage(imagens, 'latest')).toBe('ghcr.io/pterodactyl/yolks:java_25');
      expect(pickDockerImage(imagens, undefined)).toBe('ghcr.io/pterodactyl/yolks:java_25');
      expect(pickDockerImage(imagens, '25w14a')).toBe('ghcr.io/pterodactyl/yolks:java_25');
    });

    it('a imagem mais nova é achada pelo número, não pela ordem do objeto', () => {
      const forasDeOrdem = {
        'Java 25': 'ghcr.io/pterodactyl/yolks:java_25',
        'Java 8': 'ghcr.io/pterodactyl/yolks:java_8',
        'Java 17': 'ghcr.io/pterodactyl/yolks:java_17',
      };
      expect(pickDockerImage(forasDeOrdem, 'latest')).toBe('ghcr.io/pterodactyl/yolks:java_25');
    });

    // Todo template que já existe no banco tem uma imagem só, e um admin
    // que define uma imagem à mão está fazendo uma escolha explícita —
    // sobrescrever isso em silêncio seria pior do que respeitar.
    it('template com UMA imagem é respeitado, mesmo que a versão peça outra', () => {
      const uma = { 'Java 25': 'ghcr.io/pterodactyl/yolks:java_25' };
      expect(pickDockerImage(uma, '1.20.1')).toBe('ghcr.io/pterodactyl/yolks:java_25');
    });

    it('template sem imagem nenhuma devolve undefined para o chamador rejeitar', () => {
      expect(pickDockerImage({}, '1.20.1')).toBeUndefined();
    });

    it('casa pela referência da imagem quando o rótulo é outro', () => {
      const rotulosLivres = { 'padrão': 'ghcr.io/pterodactyl/yolks:java_17', 'novo': 'ghcr.io/pterodactyl/yolks:java_21' };
      expect(pickDockerImage(rotulosLivres, '1.21')).toBe('ghcr.io/pterodactyl/yolks:java_21');
    });
  });

  // Se um preset voltar a ter imagem única, a seleção por versão para de
  // funcionar para ele silenciosamente — este teste é o alarme.
  it('todo preset oferece mais de uma imagem, senão a seleção não atua', () => {
    for (const [kind, preset] of Object.entries(SOFTWARE_PRESETS)) {
      expect(Object.keys(preset.dockerImages).length).toBeGreaterThan(1);
      expect(pickDockerImage(preset.dockerImages, '1.20.1')).toContain('java_17');
      expect(kind).toBeTruthy();
    }
  });
});
