// Re-sincroniza os templates já existentes no banco com SOFTWARE_PRESETS.
//
// Por que isso existe: `seed.ts` só CRIA um template de preset quando ele
// ainda não existe (`findFirst` antes do `create`). Isso é proposital —
// re-rodar o seed nunca deve sobrescrever o que um admin ajustou à mão —
// mas tem um efeito colateral: quando um script de instalação é corrigido
// no código, todo banco que já foi semeado continua com a versão antiga
// gravada em `server_templates.install_script`, e a correção não chega a
// lugar nenhum.
//
// Foi exatamente o que aconteceu em 2026-09-19, com três bugs de uma vez:
//   - Paper: a API `api.papermc.io/v2` foi desativada ("sunset"), o build
//     resolvia para `null` e o download salvava uma página de erro como
//     server.jar ("Invalid or corrupt jarfile").
//   - Fabric: o passo final renomeava o server.jar (Minecraft VANILLA) por
//     cima do fabric-server-launch.jar (o launcher), então todo servidor
//     "Fabric" subia vanilla puro e ignorava a pasta mods/.
//   - Forge/NeoForge: do MC 1.17 em diante os instaladores não geram mais
//     jar executável (usam libraries/.../unix_args.txt), mas o startup
//     command apontava para um server.jar que nunca é criado — instalava
//     "com sucesso" e nunca subia.
//
// Uso:
//   pnpm --dir apps/api run sync:preset-templates                      # simulação — só imprime o que MUDARIA
//   pnpm --dir apps/api run sync:preset-templates -- --apply           # grava
//   pnpm --dir apps/api run sync:preset-templates -- --images          # simula incluindo docker_images
//   pnpm --dir apps/api run sync:preset-templates -- --images --apply  # grava incluindo docker_images
//
// Diferente de `cleanup-test-plans.ts`, este script PODE rodar contra
// produção — é justamente lá que a correção precisa chegar. As proteções
// aqui são outras:
//   1. Simulação por padrão. Nada é gravado sem `--apply` explícito.
//   2. Escopo estreito: só mexe em templates cujo `software_kind` é um dos
//      PRESET_KINDS. Um template feito à mão pela "Criação avançada" (sem
//      software_kind, ou com um kind fora da lista) nunca é tocado.
//   3. Campo a campo: só grava o que realmente difere do preset, e imprime
//      cada diferença ANTES de gravar. Rodar duas vezes é inofensivo.
//   4. `docker_images` só é gravado sob `--images`, nunca por padrão.
//      Essa é a coluna que um admin tem motivo legítimo para customizar
//      (imagem/versão de Java por node), então uma divergência é apenas
//      REPORTADA a menos que você peça explicitamente. A flag existe
//      porque a escolha automática de Java por versão do Minecraft
//      (pickDockerImage) só atua em template com MAIS DE UMA imagem: um
//      template de imagem única é tratado como escolha explícita do
//      admin e respeitado como está. Todo template semeado antes dessa
//      mudança tem uma imagem só, e sem `--images` continuaria assim —
//      com um modpack de 1.20.1 caindo na JRE mais nova e morrendo ao
//      carregar os mods.
//   5. Ao final, lista os servidores que usam esses templates. Corrigir o
//      template NÃO conserta um servidor já instalado: os arquivos em
//      disco dele continuam sendo o resultado do script antigo. Esses
//      precisam de reinstalação.
import { PrismaClient } from '@prisma/client';
import { PRESET_KINDS, SOFTWARE_PRESETS } from '../src/modules/templates/software-presets';

const prisma = new PrismaClient();

/** Campos derivados do preset que este script mantém em dia. */
const SYNCED_FIELDS = ['description', 'installScript', 'startupCommand', 'installImage', 'installEntrypoint'] as const;
type SyncedField = (typeof SYNCED_FIELDS)[number];

function short(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const syncImages = process.argv.includes('--images');
  console.log(apply ? '=== APLICANDO (gravando no banco) ===' : '=== SIMULAÇÃO — nada será gravado (use -- --apply para gravar) ===');
  console.log(syncImages ? '=== docker_images INCLUÍDO (--images) ===\n' : '=== docker_images preservado (use -- --images para sincronizar também) ===\n');

  let changedCount = 0;

  for (const kind of PRESET_KINDS) {
    const preset = SOFTWARE_PRESETS[kind];
    const templates = await prisma.serverTemplate.findMany({
      where: { softwareKind: kind, deletedAt: null },
      select: {
        id: true,
        name: true,
        dockerImages: true,
        description: true,
        installScript: true,
        startupCommand: true,
        installImage: true,
        installEntrypoint: true,
      },
    });

    if (templates.length === 0) {
      console.log(`[${kind}] nenhum template com esse software_kind — nada a fazer`);
      continue;
    }

    for (const template of templates) {
      const differing = SYNCED_FIELDS.filter((f) => template[f] !== preset[f]);

      // docker_images só é gravado sob --images, nunca por padrão
      // (proteção 4 acima). Sem a flag, uma divergência é apenas
      // reportada para você decidir.
      const presetImages = JSON.stringify(preset.dockerImages);
      const currentImages = JSON.stringify(template.dockerImages);
      const imagesDiffer = presetImages !== currentImages;
      if (imagesDiffer) {
        const sufixo = syncImages ? '→ SERÁ atualizado (--images)' : '(NÃO alterado — use --images para sincronizar)';
        console.log(`[${kind}] "${template.name}" ⚠ docker_images difere do preset ${sufixo}:`);
        console.log(`        no banco: ${currentImages}`);
        console.log(`        no preset: ${presetImages}`);
        // Uma imagem só significa que a seleção por versão de Java fica
        // inativa para esse template: pickDockerImage respeita um mapa de
        // uma entrada como escolha explícita do admin. É por isso que
        // sincronizar as imagens importa — sem o mapa completo, um
        // modpack de 1.20.1 continua caindo na JRE mais nova e morre
        // carregando os mods.
        if (Object.keys(template.dockerImages as Record<string, string>).length <= 1) {
          console.log('        nota: com uma imagem só, a escolha automática de Java NÃO atua neste template');
        }
      }

      if (syncImages && imagesDiffer) {
        changedCount++;
        if (apply) {
          await prisma.serverTemplate.update({ where: { id: template.id }, data: { dockerImages: preset.dockerImages } });
          console.log('        ✓ docker_images gravado');
        }
      }

      if (differing.length === 0) {
        // Não anuncia "em dia" quando as imagens divergem: o bloco acima
        // já disse o que há, e as duas mensagens juntas se contradiriam.
        if (!imagesDiffer) console.log(`[${kind}] "${template.name}" já está em dia`);
        continue;
      }

      changedCount++;
      console.log(`[${kind}] "${template.name}" → atualizar: ${differing.join(', ')}`);
      for (const field of differing) {
        // install_script tem centenas de linhas; imprimir inteiro só
        // afogaria o relatório que você precisa ler antes do --apply.
        if (field === 'installScript') {
          console.log(`        installScript: ${template.installScript.length} caracteres → ${preset.installScript.length} caracteres`);
        } else {
          console.log(`        ${field}:`);
          console.log(`          antes: ${short(String(template[field as SyncedField] ?? ''))}`);
          console.log(`          depois: ${short(String(preset[field as SyncedField]))}`);
        }
      }

      if (apply) {
        const data: Record<string, string> = {};
        for (const field of differing) data[field] = preset[field] as string;
        await prisma.serverTemplate.update({ where: { id: template.id }, data });
        console.log('        ✓ gravado');
      }
    }
  }

  // Servidores já instalados continuam com os arquivos gerados pelo script
  // ANTIGO — corrigir o template não reescreve nada em disco. `servers` tem
  // RLS, então a leitura precisa de contexto admin, do mesmo jeito que
  // PrismaService.withRLS faz na aplicação.
  const servers = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', '', true)`;
    await tx.$executeRaw`SELECT set_config('app.is_admin', 'on', true)`;
    return tx.server.findMany({
      where: { template: { softwareKind: { in: [...PRESET_KINDS] } } },
      select: { name: true, status: true, template: { select: { name: true, softwareKind: true } } },
      orderBy: { createdAt: 'desc' },
    });
  });

  console.log(`\n=== servidores que usam templates de preset (${servers.length}) ===`);
  for (const s of servers) {
    console.log(`  "${s.name}" [${s.status}] → template "${s.template?.name}" (${s.template?.softwareKind})`);
  }
  if (servers.length > 0) {
    console.log('\n  Atenção: corrigir o template NÃO conserta estes servidores.');
    console.log('  Os arquivos em disco deles ainda são o resultado do script antigo —');
    console.log('  cada um precisa ser REINSTALADO para pegar o script novo.');
  }

  if (!apply && changedCount > 0) {
    console.log(`\n${changedCount} template(s) seriam alterados. Rode de novo com -- --apply para gravar.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
