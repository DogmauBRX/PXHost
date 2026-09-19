-- Keep the public software-selection cards in Brazilian Portuguese for
-- existing installations. Fresh databases receive the same text from
-- software-presets.ts through the idempotent seed.
UPDATE "server_templates"
SET "description" = CASE "software_kind"
  WHEN 'paper' THEN 'Servidor Paper de alto desempenho para Minecraft: Java Edition.'
  WHEN 'fabric' THEN 'Servidor modificado de Minecraft: Java Edition com o carregador de mods Fabric.'
  WHEN 'quilt' THEN 'Servidor modificado de Minecraft: Java Edition com o carregador de mods Quilt.'
  WHEN 'vanilla' THEN 'Servidor oficial e sem modificações do Minecraft: Java Edition — sem plugins ou mods.'
  WHEN 'forge' THEN 'Servidor modificado de Minecraft: Java Edition com o carregador de mods Forge.'
  WHEN 'neoforge' THEN 'Servidor modificado de Minecraft: Java Edition com NeoForge, fork do Forge mantido ativamente para versões modernas.'
  WHEN 'purpur' THEN 'Servidor baseado no Paper com ajustes extras de desempenho e jogabilidade — compatível com plugins do Paper.'
  ELSE "description"
END
WHERE "software_kind" IN ('paper', 'fabric', 'quilt', 'vanilla', 'forge', 'neoforge', 'purpur');
