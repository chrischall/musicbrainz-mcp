import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { client } from '../../src/client.js';
import { registerTagTools } from '../../src/tools/tags.js';
import { registerRatingTools } from '../../src/tools/ratings.js';
import { registerCollectionTools } from '../../src/tools/collections.js';
import { createTestHarness } from '../helpers.js';

const write = vi.spyOn(client, 'write').mockResolvedValue('OK');

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => write.mockClear());
afterAll(async () => {
  if (harness) await harness.close();
});

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

const MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';
const MBID2 = '89ad4ac3-39f7-470e-963a-56509c546377';

describe('write tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerTagTools(server);
      registerRatingTools(server);
      registerCollectionTools(server);
    });
  });

  // --- tags ---
  it('submit_tags dry-runs without confirm and makes NO call', async () => {
    const r = await harness.callTool('musicbrainz_submit_tags', { entity: 'recording', mbid: MBID, tags: ['punk'] });
    const body = parse(r as never);
    expect(body.dryRun).toBe(true);
    expect(body.vote).toBe('upvote');
    expect(String(body.xml)).toContain('<user-tag vote="upvote"><name>punk</name>');
    expect(write).not.toHaveBeenCalled();
  });

  it('submit_tags posts /tag with confirm', async () => {
    const r = await harness.callTool('musicbrainz_submit_tags', {
      entity: 'recording',
      mbid: MBID,
      tags: ['punk', 'grunge'],
      vote: 'downvote',
      confirm: true,
    });
    expect(write).toHaveBeenCalledTimes(1);
    const [method, path, opts] = write.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/tag');
    expect((opts as { xmlBody: string }).xmlBody).toContain('vote="downvote"');
    expect(parse(r as never).submitted).toBe(true);
  });

  it('submit_tags rejects an empty tag list', async () => {
    const r = await harness.callTool('musicbrainz_submit_tags', { entity: 'artist', mbid: MBID, tags: [] });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  // --- ratings ---
  it('submit_rating dry-runs without confirm', async () => {
    const r = await harness.callTool('musicbrainz_submit_rating', { entity: 'release-group', mbid: MBID, rating: 80 });
    expect(parse(r as never).dryRun).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('submit_rating posts /rating with confirm', async () => {
    await harness.callTool('musicbrainz_submit_rating', { entity: 'release-group', mbid: MBID, rating: 100, confirm: true });
    const [method, path, opts] = write.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/rating');
    expect((opts as { xmlBody: string }).xmlBody).toContain('<user-rating>100</user-rating>');
  });

  it('submit_rating rejects out-of-range', async () => {
    const r = await harness.callTool('musicbrainz_submit_rating', { entity: 'artist', mbid: MBID, rating: 101, confirm: true });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  // --- collections ---
  it('modify_collection dry-runs without confirm', async () => {
    const r = await harness.callTool('musicbrainz_modify_collection', {
      action: 'add',
      collection: MBID,
      entityType: 'releases',
      mbids: [MBID2],
    });
    const body = parse(r as never);
    expect(body.dryRun).toBe(true);
    expect(body.method).toBe('PUT');
    expect(write).not.toHaveBeenCalled();
  });

  it('modify_collection PUTs on add with confirm', async () => {
    await harness.callTool('musicbrainz_modify_collection', {
      action: 'add',
      collection: MBID,
      entityType: 'releases',
      mbids: [MBID, MBID2],
      confirm: true,
    });
    const [method, path] = write.mock.calls[0];
    expect(method).toBe('PUT');
    expect(path).toBe(`/collection/${MBID}/releases/${MBID};${MBID2}`);
  });

  it('modify_collection DELETEs on remove with confirm', async () => {
    await harness.callTool('musicbrainz_modify_collection', {
      action: 'remove',
      collection: MBID,
      entityType: 'works',
      mbids: [MBID2],
      confirm: true,
    });
    const [method, path] = write.mock.calls[0];
    expect(method).toBe('DELETE');
    expect(path).toBe(`/collection/${MBID}/works/${MBID2}`);
  });
});
