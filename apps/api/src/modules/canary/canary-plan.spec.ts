import { CANARY_SCENARIOS, assignScenarios, pickModpackVersion, pickPlanForNode } from './canary-plan';

const templates = new Map(CANARY_SCENARIOS.map((s) => [s.softwareKind, `tpl-${s.softwareKind}`]));
const n1 = { nodeId: 'n1', nodeName: 'node01', planId: 'basico' };
const n2 = { nodeId: 'n2', nodeName: 'node02', planId: 'medio' };

describe('assignScenarios', () => {
  it('runs every software exactly once, spread across nodes', () => {
    const { assignments } = assignScenarios(CANARY_SCENARIOS, templates, [n1, n2], 0);
    expect(assignments.map((a) => a.scenario.softwareKind)).toEqual(CANARY_SCENARIOS.map((s) => s.softwareKind));
    const perNode = assignments.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.target.nodeId]: (acc[a.target.nodeId] ?? 0) + 1 }), {});
    expect(perNode).toEqual({ n1: 4, n2: 3 });
  });

  it('rotates so the next night puts each software on the other node', () => {
    const day0 = assignScenarios(CANARY_SCENARIOS, templates, [n1, n2], 0).assignments;
    const day1 = assignScenarios(CANARY_SCENARIOS, templates, [n1, n2], 1).assignments;
    day0.forEach((a, i) => expect(day1[i].target.nodeId).not.toBe(a.target.nodeId));
  });

  it('reports software without a template instead of failing', () => {
    const partial = new Map([['paper', 'tpl-paper']]);
    const { assignments, missingTemplates } = assignScenarios(CANARY_SCENARIOS, partial, [n1], 3);
    expect(assignments).toHaveLength(1);
    expect(missingTemplates).toEqual(['purpur', 'vanilla', 'fabric', 'quilt', 'forge', 'neoforge']);
  });

  it('assigns nothing when no node can host a canary', () => {
    expect(assignScenarios(CANARY_SCENARIOS, templates, [], 0).assignments).toEqual([]);
  });
});

describe('pickPlanForNode', () => {
  const plans = [
    { id: 'avancado', priceCents: 6000, nodeIds: ['n2'] },
    { id: 'medio', priceCents: 4000, nodeIds: ['n2'] },
    { id: 'basico', priceCents: 2500, nodeIds: ['n1'] },
  ];
  it('picks the cheapest plan the node accepts', () => {
    expect(pickPlanForNode('n2', plans)).toBe('medio');
    expect(pickPlanForNode('n1', plans)).toBe('basico');
  });
  it('treats unrestricted plans as allowed everywhere', () => {
    expect(pickPlanForNode('n3', [...plans, { id: 'livre', priceCents: 9000, nodeIds: [] }])).toBe('livre');
    expect(pickPlanForNode('n3', plans)).toBeNull();
  });
});

describe('pickModpackVersion', () => {
  const base = { projectId: 'p', publishedAt: '2026-01-01', releaseType: 'release' };
  it('takes the newest release for the loader and its newest game version', () => {
    const picked = pickModpackVersion(
      [
        { ...base, versionId: 'old', loaders: ['fabric'], minecraftVersions: ['26.1'], publishedAt: '2026-05-01' },
        { ...base, versionId: 'beta', loaders: ['fabric'], minecraftVersions: ['26.3'], publishedAt: '2026-10-01', releaseType: 'beta' },
        { ...base, versionId: 'new', loaders: ['fabric'], minecraftVersions: ['26.2', '26.3'], publishedAt: '2026-09-01' },
        { ...base, versionId: 'quilt-only', loaders: ['quilt'], minecraftVersions: ['26.3'], publishedAt: '2026-10-02' },
      ],
      'fabric',
    );
    expect(picked).toEqual({ versionId: 'new', projectId: 'p', minecraftVersion: '26.3' });
  });
  it('returns null when no version targets the loader', () => {
    expect(pickModpackVersion([{ ...base, versionId: 'x', loaders: ['forge'], minecraftVersions: ['1.20.1'] }], 'fabric')).toBeNull();
  });
});
