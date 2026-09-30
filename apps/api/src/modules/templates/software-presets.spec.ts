import { pickStartupCommand, SOFTWARE_PRESETS } from './software-presets';

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

  it('starts legacy Forge jars directly because Java 8 cannot read @argfiles', () => {
    const configured = SOFTWARE_PRESETS.forge.startupCommand;

    expect(pickStartupCommand('forge', configured, '1.7.10')).toBe(
      'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui',
    );
    expect(pickStartupCommand('forge', configured, '1.16.5')).toContain('-jar {{SERVER_JARFILE}}');
    expect(pickStartupCommand('forge', configured, '1.17.1')).toBe(configured);
    expect(pickStartupCommand('forge', configured, 'latest')).toBe(configured);
  });

  it('repairs persisted variants of the old preset but leaves unrelated custom commands alone', () => {
    expect(pickStartupCommand('forge', 'java -Xmx2G   @unix_args.txt nogui', '1.7.10')).toBe(
      'java -Xmx2G   -jar {{SERVER_JARFILE}} nogui',
    );
    expect(pickStartupCommand('forge', 'java -jar custom.jar', '1.7.10')).toBe('java -jar custom.jar');
    expect(pickStartupCommand('paper', SOFTWARE_PRESETS.forge.startupCommand, '1.7.10')).toBe(SOFTWARE_PRESETS.forge.startupCommand);
  });
});
