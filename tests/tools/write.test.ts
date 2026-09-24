import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { client } from '../../src/client.js';
import { registerTagTools } from '../../src/tools/tags.js';
import { registerRatingTools } from '../../src/tools/ratings.js';
import { registerCollectionTools } from '../../src/tools/collections.js';
import { createTestHarness } from '../helpers.js';

const write = vi.spyOn(client, 'write').mockResolvedValue('OK');

type Harness = Awaited<ReturnType<typeof createTestHarness>>;
type Result = Awaited<ReturnType<Harness['callTool']>>;

function registerAll(server: McpServer): void {
  registerTagTools(server);
  registerRatingTools(server);
  registerCollectionTools(server);
}

// A harness created WITHOUT an elicitation handler is a client that cannot be
// prompted, so the default MCP_CONFIRM_MODE (ask-user) runs the token flow.
let harness: Harness;
beforeAll(async () => {
  harness = await createTestHarness(registerAll);
});
afterAll(async () => {
  await harness.close();
});

const ENV_KEYS = ['MCP_CONFIRM_MODE', 'MCP_CONFIRM_TTL_SECONDS', 'MCP_CONFIRM_SECRET'] as const;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  write.mockClear();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function parse(result: Result): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

/** Phase 1: must be a confirmation-required preview with a token, and make NO call. */
async function phaseOne(
  name: string,
  args: Record<string, unknown>,
  h: Harness = harness
): Promise<{ body: Record<string, unknown>; preview: Record<string, unknown>; token: string }> {
  const r = await h.callTool(name, args);
  const body = parse(r);
  expect(body.status).toBe('confirmation-required');
  expect(typeof body.confirmToken).toBe('string');
  expect(write).not.toHaveBeenCalled();
  return { body, preview: body.preview as Record<string, unknown>, token: body.confirmToken as string };
}

const MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';
const MBID2 = '89ad4ac3-39f7-470e-963a-56509c546377';

describe('musicbrainz_submit_tags', () => {
  const args = { entity: 'recording', mbid: MBID, tags: ['punk', 'grunge'], vote: 'downvote' };

  it('phase 1 previews the exact XML and makes NO call', async () => {
    const { body, preview } = await phaseOne('musicbrainz_submit_tags', {
      entity: 'recording',
      mbid: MBID,
      tags: ['punk'],
    });
    expect(body.action).toBe('musicbrainz.submit_tags');
    expect(preview.method).toBe('POST');
    expect(preview.path).toBe('/tag');
    expect(preview.entity).toBe('recording');
    expect(preview.mbid).toBe(MBID);
    expect(preview.tags).toEqual(['punk']);
    expect(preview.vote).toBe('upvote');
    expect(String(preview.xml)).toContain('<user-tag vote="upvote"><name>punk</name>');
    expect(String(preview.note)).toContain('submit these tags');
  });

  it('phase 2 with the token posts /tag exactly once', async () => {
    const { token } = await phaseOne('musicbrainz_submit_tags', args);
    const r = await harness.callTool('musicbrainz_submit_tags', { ...args, confirmToken: token });
    expect(write).toHaveBeenCalledTimes(1);
    const [method, path, opts] = write.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/tag');
    expect((opts as { xmlBody: string }).xmlBody).toContain('vote="downvote"');
    expect(parse(r).submitted).toBe(true);
  });

  it('replaying a used token is refused as TOKEN_REUSED and makes no call', async () => {
    const { token } = await phaseOne('musicbrainz_submit_tags', args);
    await harness.callTool('musicbrainz_submit_tags', { ...args, confirmToken: token });
    expect(write).toHaveBeenCalledTimes(1);
    const r = await harness.callTool('musicbrainz_submit_tags', { ...args, confirmToken: token });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('TOKEN_REUSED');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('changing an argument between phases is refused as DRAFT_CHANGED and makes no call', async () => {
    const { token } = await phaseOne('musicbrainz_submit_tags', args);
    const r = await harness.callTool('musicbrainz_submit_tags', {
      ...args,
      tags: ['punk', 'metal'],
      confirmToken: token,
    });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('DRAFT_CHANGED');
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects an empty tag list', async () => {
    const r = await harness.callTool('musicbrainz_submit_tags', { entity: 'artist', mbid: MBID, tags: [] });
    expect(r.isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('musicbrainz_submit_rating', () => {
  it('phase 1 previews the XML and makes NO call', async () => {
    const { preview } = await phaseOne('musicbrainz_submit_rating', {
      entity: 'release-group',
      mbid: MBID,
      rating: 80,
    });
    expect(preview.method).toBe('POST');
    expect(preview.path).toBe('/rating');
    expect(preview.rating).toBe(80);
    expect(String(preview.xml)).toContain('<user-rating>80</user-rating>');
    expect(String(preview.note)).toContain('submit this rating');
  });

  it('phase 1 of a 0 rating says it REMOVES the rating', async () => {
    const { preview } = await phaseOne('musicbrainz_submit_rating', { entity: 'artist', mbid: MBID, rating: 0 });
    expect(String(preview.note)).toContain('REMOVE');
  });

  it('phase 2 with the token posts /rating exactly once', async () => {
    const args = { entity: 'release-group', mbid: MBID, rating: 100 };
    const { token } = await phaseOne('musicbrainz_submit_rating', args);
    const r = await harness.callTool('musicbrainz_submit_rating', { ...args, confirmToken: token });
    expect(write).toHaveBeenCalledTimes(1);
    const [method, path, opts] = write.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/rating');
    expect((opts as { xmlBody: string }).xmlBody).toContain('<user-rating>100</user-rating>');
    expect(parse(r).note).toBe('Rating submitted to your MusicBrainz account.');
  });

  it('phase 2 of a 0 rating reports the removal', async () => {
    const args = { entity: 'artist', mbid: MBID, rating: 0 };
    const { token } = await phaseOne('musicbrainz_submit_rating', args);
    const r = await harness.callTool('musicbrainz_submit_rating', { ...args, confirmToken: token });
    expect(write).toHaveBeenCalledTimes(1);
    expect(parse(r).note).toBe('Rating removed from your MusicBrainz account.');
  });

  it('rejects out-of-range', async () => {
    const r = await harness.callTool('musicbrainz_submit_rating', { entity: 'artist', mbid: MBID, rating: 101 });
    expect(r.isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('musicbrainz_modify_collection', () => {
  it('phase 1 previews method/path and makes NO call', async () => {
    const { preview } = await phaseOne('musicbrainz_modify_collection', {
      action: 'add',
      collection: MBID,
      entityType: 'releases',
      mbids: [MBID2],
    });
    expect(preview.action).toBe('add_collection');
    expect(preview.method).toBe('PUT');
    expect(preview.path).toBe(`/collection/${MBID}/releases/${MBID2}`);
    expect(preview.collection).toBe(MBID);
    expect(preview.entityType).toBe('releases');
    expect(preview.mbids).toEqual([MBID2]);
    expect(String(preview.note)).toContain('add 1 releases to the collection');
  });

  it('phase 2 PUTs on add exactly once', async () => {
    const args = { action: 'add', collection: MBID, entityType: 'releases', mbids: [MBID, MBID2] };
    const { token } = await phaseOne('musicbrainz_modify_collection', args);
    const r = await harness.callTool('musicbrainz_modify_collection', { ...args, confirmToken: token });
    expect(write).toHaveBeenCalledTimes(1);
    const [method, path] = write.mock.calls[0];
    expect(method).toBe('PUT');
    expect(path).toBe(`/collection/${MBID}/releases/${MBID};${MBID2}`);
    expect(parse(r).note).toBe('2 releases added to your MusicBrainz collection.');
  });

  it('phase 2 DELETEs on remove exactly once', async () => {
    const args = { action: 'remove', collection: MBID, entityType: 'works', mbids: [MBID2] };
    const { preview, token } = await phaseOne('musicbrainz_modify_collection', args);
    expect(preview.method).toBe('DELETE');
    expect(String(preview.note)).toContain('remove 1 works from the collection');
    const r = await harness.callTool('musicbrainz_modify_collection', { ...args, confirmToken: token });
    expect(write).toHaveBeenCalledTimes(1);
    const [method, path] = write.mock.calls[0];
    expect(method).toBe('DELETE');
    expect(path).toBe(`/collection/${MBID}/works/${MBID2}`);
    expect(parse(r).note).toBe('1 works removed from your MusicBrainz collection.');
  });

  it('a token cannot be reused after switching add to remove', async () => {
    const args = { action: 'add', collection: MBID, entityType: 'releases', mbids: [MBID2] };
    const { token } = await phaseOne('musicbrainz_modify_collection', args);
    const r = await harness.callTool('musicbrainz_modify_collection', {
      ...args,
      action: 'remove',
      confirmToken: token,
    });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('DRAFT_CHANGED');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('confirmation modes', () => {
  it('a client that can be prompted writes after accept', async () => {
    const h = await createTestHarness(registerAll, {
      elicitation: async () => ({ action: 'accept', content: { confirmed: true } }),
    });
    try {
      const r = await h.callTool('musicbrainz_submit_rating', { entity: 'artist', mbid: MBID, rating: 60 });
      expect(write).toHaveBeenCalledTimes(1);
      expect(parse(r).submitted).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('a client that can be prompted does not write after decline', async () => {
    const h = await createTestHarness(registerAll, {
      elicitation: async () => ({ action: 'decline' }),
    });
    try {
      await h.callTool('musicbrainz_submit_tags', { entity: 'artist', mbid: MBID, tags: ['rock'] });
      expect(write).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('MCP_CONFIRM_MODE=refuse refuses on a client that cannot be prompted', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    const r = await harness.callTool('musicbrainz_modify_collection', {
      action: 'add',
      collection: MBID,
      entityType: 'releases',
      mbids: [MBID2],
    });
    expect(parse(r).reason).toBe('confirmation-unsupported');
    expect(write).not.toHaveBeenCalled();
  });
});
