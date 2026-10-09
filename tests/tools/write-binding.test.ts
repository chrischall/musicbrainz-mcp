import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';

// Record what each write tool hands `confirmationFromEnv`, while keeping the
// real implementation so the gate still behaves exactly as in production.
const seen: Array<Record<string, unknown>> = [];
vi.mock('@chrischall/mcp-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chrischall/mcp-utils')>();
  return {
    ...actual,
    confirmationFromEnv: (opts: Parameters<typeof actual.confirmationFromEnv>[0]) => {
      seen.push(opts as unknown as Record<string, unknown>);
      return actual.confirmationFromEnv(opts);
    },
  };
});

const { client } = await import('../../src/client.js');
const { registerTagTools } = await import('../../src/tools/tags.js');
const { registerRatingTools } = await import('../../src/tools/ratings.js');
const { registerCollectionTools } = await import('../../src/tools/collections.js');
const { createTestHarness } = await import('../helpers.js');

const write = vi.spyOn(client, 'write').mockResolvedValue('OK');

function registerAll(server: McpServer): void {
  registerTagTools(server);
  registerRatingTools(server);
  registerCollectionTools(server);
}

const MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';
const MBID2 = '89ad4ac3-39f7-470e-963a-56509c546377';

// fleet-audit#1066: on the elicitation rail an acceptance must be bound to the
// arguments it approved (as the token rail already is), so every write tool
// passes its validated arguments to confirmationFromEnv, which turns them into
// a `binding`.
describe('write tools bind the confirmation to their arguments', () => {
  type Harness = Awaited<ReturnType<typeof createTestHarness>>;
  let h: Harness;
  beforeAll(async () => {
    h = await createTestHarness(registerAll, {
      elicitation: async () => ({ action: 'accept', content: { confirmed: true } }),
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    seen.length = 0;
    write.mockClear();
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    ['musicbrainz_submit_tags', { entity: 'recording', mbid: MBID, tags: ['punk'], vote: 'withdraw' }],
    ['musicbrainz_submit_rating', { entity: 'artist', mbid: MBID, rating: 40 }],
    ['musicbrainz_modify_collection', { action: 'remove', collection: MBID, entityType: 'releases', mbids: [MBID2] }],
  ];

  it.each(cases)('%s passes its arguments as `args` and still writes after accept', async (name, args) => {
    const r = await h.callTool(name, args);
    expect(r.isError).toBeFalsy();
    // The handler runs once to prompt and again with the answer; both runs
    // must carry the arguments, or the second could not check the binding.
    expect(seen.length).toBeGreaterThan(0);
    for (const opts of seen) expect(opts.args).toMatchObject(args);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
