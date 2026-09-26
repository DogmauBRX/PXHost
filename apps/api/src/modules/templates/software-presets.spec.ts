import { SOFTWARE_PRESETS } from './software-presets';

describe('software presets', () => {
  it('keeps the Fabric launcher created by the official installer', () => {
    const script = SOFTWARE_PRESETS.fabric.installScript;

    expect(script).toContain('java -jar fabric-installer.jar server');
    expect(script).not.toContain('mv server.jar "${SERVER_JARFILE}"');
  });

  it('resolves Forge latest to the newest build before the recommended fallback', () => {
    const script = SOFTWARE_PRESETS.forge.installScript;

    expect(script).toContain('.promos[($v + "-latest")] // .promos[($v + "-recommended")]');
  });
});
