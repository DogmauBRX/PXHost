import { planCurseForgeRetrySkips } from './curseforge-retry-plan';
import type { CurseForgeProjectMeta } from '../plugins/curseforge.provider';

// Project ids here are arbitrary; the shapes mirror DeceasedCraft 5.10.17,
// where these exact crashes were captured live on 2026-09-27.
const OCULUS = 1;
const COLORWHEEL = 2;
const COLORWHEEL_PATCHER = 3;
const SODIUM_EXTRAS = 4;
const ITEMPHYSIC_LITE = 5;
const FRAMEWORK = 6;
const CONTROLLABLE = 7;
const CGM = 8;

const meta: Record<number, CurseForgeProjectMeta> = {
  [OCULUS]: { slug: 'oculus', name: 'Oculus', requires: [] },
  [COLORWHEEL]: { slug: 'colorwheel', name: 'Colorwheel', requires: [OCULUS] },
  [COLORWHEEL_PATCHER]: { slug: 'colorwheel-patcher', name: 'Colorwheel Patcher', requires: [COLORWHEEL] },
  [SODIUM_EXTRAS]: { slug: 'sodium-extras', name: 'Sodium Extras', requires: [] },
  [ITEMPHYSIC_LITE]: { slug: 'itemphysic-lite', name: 'ItemPhysic Lite', requires: [] },
  [FRAMEWORK]: { slug: 'framework', name: 'Framework', requires: [] },
  [CONTROLLABLE]: { slug: 'controllable', name: 'Controllable', requires: [FRAMEWORK] },
  [CGM]: { slug: 'mrcrayfishs-gun-mod', name: "MrCrayfish's Gun Mod", requires: [FRAMEWORK] },
};

const missingDependencyCrash = [
  'net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [',
  'Mod §ecolorwheel§r requires §6oculus§r §o1.7.0 or above§r',
].join('\n');

const clientCodeCrash = [
  '[main/ERROR] [minecraft/Main]: Failed to start the minecraft server',
  'net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [',
  '\tSodium Extras (sodiumextras) has failed to load correctly',
  '§7java.lang.RuntimeException: Attempted to load class net/minecraft/client/Options for invalid dist DEDICATED_SERVER,',
  '\tItemPhysicLite (itemphysiclite) has failed to load correctly',
  '§7java.lang.ExceptionInInitializerError: null,',
  '\tFramework (framework) has failed to load correctly',
  '§7java.lang.NoClassDefFoundError: net/minecraft/client/gui/components/toasts/Toast',
  ']',
].join('\n');

describe('planCurseForgeRetrySkips', () => {
  it('skips a mod that requires one we skipped, plus anything that requires it in turn', () => {
    expect(planCurseForgeRetrySkips(missingDependencyCrash, meta, [OCULUS]).sort()).toEqual([COLORWHEEL, COLORWHEEL_PATCHER]);
  });

  it('ignores a missing dependency we did not skip ourselves', () => {
    expect(planCurseForgeRetrySkips(missingDependencyCrash, meta, [])).toEqual([]);
  });

  it('skips a mod that reached for client-only code, matching mod id to slug despite punctuation', () => {
    expect(planCurseForgeRetrySkips(clientCodeCrash, meta, [])).toContain(SODIUM_EXTRAS);
  });

  it('never skips a mod that kept mods require, even when it shows a client-code error (the Framework trap)', () => {
    expect(planCurseForgeRetrySkips(clientCodeCrash, meta, [])).not.toContain(FRAMEWORK);
  });

  it('does not treat a failure without a client-only cause as client-only', () => {
    // ItemPhysicLite's own cause here is an ExceptionInInitializerError, not client code.
    expect(planCurseForgeRetrySkips(clientCodeCrash, meta, [])).not.toContain(ITEMPHYSIC_LITE);
  });

  it('matches by display name when the mod id is unrelated to the slug', () => {
    const crash = [
      '\tItemPhysic Lite (weirdid) has failed to load correctly',
      '§7java.lang.NoClassDefFoundError: net/minecraft/client/renderer/ItemRenderer',
    ].join('\n');
    expect(planCurseForgeRetrySkips(crash, meta, [])).toEqual([ITEMPHYSIC_LITE]);
  });

  it('returns nothing for an unrelated failure', () => {
    expect(planCurseForgeRetrySkips('java.lang.OutOfMemoryError: Java heap space', meta, [])).toEqual([]);
  });

  it('does not re-add projects already skipped', () => {
    expect(planCurseForgeRetrySkips(missingDependencyCrash, meta, [OCULUS, COLORWHEEL, COLORWHEEL_PATCHER])).toEqual([]);
  });
});
