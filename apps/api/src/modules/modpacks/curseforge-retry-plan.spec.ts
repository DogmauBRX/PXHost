import { planCurseForgeRetrySkips } from './curseforge-retry-plan';
import type { CurseForgeProjectMeta } from '../plugins/curseforge.provider';

// Slugs, names and jar names below are the real ones from DeceasedCraft
// 5.10.17, where these exact crashes were captured live on 2026-09-27.
const OCULUS = 581495;
const COLORWHEEL = 1254143;
const COLORWHEEL_PATCHER = 1285475;
const SODIUM_EXTRAS = 558905;
const ITEMPHYSIC_LITE = 270441;
const FRAMEWORK = 549225;
const CONTROLLABLE = 317269;
const CREATIVECORE = 257814;
const CREATE_BETTER_FPS = 900001;
const DISTANT_HORIZONS = 396890;

const meta: Record<number, CurseForgeProjectMeta> = {
  [OCULUS]: { slug: 'oculus', name: 'Oculus', requires: [], filename: 'oculus-mc1.20.1-1.8.0.jar' },
  [COLORWHEEL]: { slug: 'colorwheel', name: 'Colorwheel', requires: [OCULUS], filename: 'colorwheel-forge-1.1.1+mc1.20.1.jar' },
  [COLORWHEEL_PATCHER]: { slug: 'colorwheel-patcher', name: 'Colorwheel Patcher', requires: [COLORWHEEL], filename: 'colorwheel_patcher-forge-1.0.3+mc1.20.1.jar' },
  [SODIUM_EXTRAS]: { slug: 'magnesium-extras', name: 'Sodium/Embeddium Extras', requires: [], filename: 'sodiumextras-forge-1.0.7-1.20.1.jar' },
  [ITEMPHYSIC_LITE]: { slug: 'itemphysic-lite', name: 'ItemPhysic Lite', requires: [CREATIVECORE], filename: 'ItemPhysicLite_FORGE_v1.6.6_mc1.20.1.jar' },
  [CREATIVECORE]: { slug: 'creativecore', name: 'CreativeCore', requires: [], filename: 'CreativeCore_FORGE_v2.12.9_mc1.20.1.jar' },
  [FRAMEWORK]: { slug: 'framework', name: 'Framework', requires: [], filename: 'framework-forge-1.20.1-0.7.15.jar' },
  [CONTROLLABLE]: { slug: 'controllable', name: 'Controllable', requires: [FRAMEWORK], filename: 'controllable-forge-1.20.1-0.21.7.jar' },
  [CREATE_BETTER_FPS]: { slug: 'create-better-fps', name: 'Create Better FPS', requires: [], filename: 'createbetterfps-1.20.1-1.1.1.jar' },
  [DISTANT_HORIZONS]: { slug: 'distant-horizons', name: 'Distant Horizons', requires: [], filename: 'DistantHorizons-2.3.5-b-1.20.1-forge.jar' },
};

// Verbatim from the live crash after Framework's own dependents were removed.
const sidedSetupCrash = [
  'net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [',
  'Distant Horizons (distanthorizons) encountered an error during the sided_setup event phase',
  '§7java.lang.NullPointerException: Cannot invoke "com.seibel.distanthorizons.core.wrapperInterfaces.minecraft.IMinecraftClientWrapper.crashMinecraft(String, java.lang.Throwable)" because "com.seibel.distanthorizons.core.Initializer.MC_CLIENT" is null',
].join('\n');

const missingDependencyCrash = [
  'net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [',
  'Mod §ecolorwheel§r requires §6oculus§r §o1.7.0 or above§r',
].join('\n');

// Verbatim from the Agent's error message on the live retest.
const constructCrash = [
  'o servidor não terminou de iniciar com o modpack (estado: crashed):',
  'Sodium Extras (sodiumextras) has failed to load correctly',
  '§7java.lang.RuntimeException: Attempted to load class net/minecraft/client/Options for invalid dist DEDICATED_SERVER,',
  'ItemPhysicLite (itemphysiclite) has failed to load correctly',
  '§7java.lang.ExceptionInInitializerError: null,',
  'Framework (framework) has failed to load correctly',
  '§7java.lang.NoClassDefFoundError: net/minecraft/client/gui/components/toasts/Toast',
].join('\n');

describe('planCurseForgeRetrySkips', () => {
  it('skips a mod that requires one we skipped, plus anything that requires it in turn', () => {
    expect(planCurseForgeRetrySkips(missingDependencyCrash, meta, [OCULUS]).sort()).toEqual([COLORWHEEL, COLORWHEEL_PATCHER].sort());
  });

  it('ignores a missing dependency we did not skip ourselves', () => {
    expect(planCurseForgeRetrySkips(missingDependencyCrash, meta, [])).toEqual([]);
  });

  it('on the real DeceasedCraft construct crash, skips the leaf mods and keeps Framework', () => {
    expect(planCurseForgeRetrySkips(constructCrash, meta, []).sort()).toEqual([SODIUM_EXTRAS, ITEMPHYSIC_LITE].sort());
  });

  it('matches a mod id to its jar when neither slug nor name resemble it', () => {
    // "sodiumextras" vs slug "magnesium-extras" / name "Sodium/Embeddium Extras".
    expect(planCurseForgeRetrySkips(constructCrash, meta, [])).toContain(SODIUM_EXTRAS);
  });

  it('never claims a jar whose name merely starts with a shorter mod id', () => {
    const crash = 'Create (create) has failed to load correctly\n§7java.lang.NullPointerException';
    expect(planCurseForgeRetrySkips(crash, meta, [])).toEqual([]);
  });

  it('never skips a mod that kept mods require (the Framework trap)', () => {
    const crash = 'Framework (framework) has failed to load correctly\n§7java.lang.NoClassDefFoundError: net/minecraft/client/gui/components/toasts/Toast';
    expect(planCurseForgeRetrySkips(crash, meta, [])).toEqual([]);
  });

  it('skips a mod that fails during a later lifecycle phase, not just construct', () => {
    expect(planCurseForgeRetrySkips(sidedSetupCrash, meta, [])).toEqual([DISTANT_HORIZONS]);
  });

  it('returns nothing for an unrelated failure', () => {
    expect(planCurseForgeRetrySkips('java.lang.OutOfMemoryError: Java heap space', meta, [])).toEqual([]);
  });

  it('does not re-add projects already skipped', () => {
    expect(planCurseForgeRetrySkips(missingDependencyCrash, meta, [OCULUS, COLORWHEEL, COLORWHEEL_PATCHER])).toEqual([]);
  });
});
