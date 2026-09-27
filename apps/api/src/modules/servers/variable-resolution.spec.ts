import { applyPlanManagedVariables, jvmHeapMb } from './variable-resolution';

describe('jvmHeapMb', () => {
  it.each([
    [1024, 512],
    [2048, 1536],
    [5120, 4352],
    [6144, 5222],
    [12288, 10444],
  ])('leaves JVM headroom inside a %i MB container (heap %i MB)', (memoryMb, heap) => {
    expect(jvmHeapMb(memoryMb)).toBe(heap);
    expect(memoryMb - jvmHeapMb(memoryMb)).toBeGreaterThanOrEqual(Math.min(512, memoryMb - 512));
  });

  it('never goes below the 512 MB minimum the template rule enforces', () => {
    expect(jvmHeapMb(768)).toBe(512);
  });
});

describe('applyPlanManagedVariables', () => {
  it('sets SERVER_MEMORY to the heap, not the container limit', () => {
    expect(applyPlanManagedVariables({ SERVER_MEMORY: '6144', MINECRAFT_VERSION: '1.21.1' }, 6144)).toEqual({ SERVER_MEMORY: '5222', MINECRAFT_VERSION: '1.21.1' });
  });

  it('leaves templates without SERVER_MEMORY alone', () => {
    expect(applyPlanManagedVariables({ MINECRAFT_VERSION: '1.21.1' }, 6144)).toEqual({ MINECRAFT_VERSION: '1.21.1' });
  });
});
