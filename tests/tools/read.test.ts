import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { client } from '../../src/client.js';
import { registerLookupTools } from '../../src/tools/lookup.js';
import { registerSearchTools } from '../../src/tools/search.js';
import { registerBrowseTools } from '../../src/tools/browse.js';
import { registerCoverArtTools } from '../../src/tools/coverart.js';
import { registerResolveTools, parseMusicBrainzUrl } from '../../src/tools/resolve.js';
import { registerUtilityTools } from '../../src/tools/utilities.js';
import { createTestHarness } from '../helpers.js';

const get = vi.spyOn(client, 'get').mockResolvedValue(undefined as never);
const coverArt = vi.spyOn(client, 'coverArt').mockResolvedValue(undefined as never);

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => {
  get.mockClear();
  coverArt.mockClear();
});
afterAll(async () => {
  if (harness) await harness.close();
});

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

const ARTIST_MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';

describe('read tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerLookupTools(server);
      registerSearchTools(server);
      registerBrowseTools(server);
      registerCoverArtTools(server);
      registerResolveTools(server);
      registerUtilityTools(server);
    });
  });

  it('lookup joins inc with + and calls the entity path', async () => {
    get.mockResolvedValueOnce({ name: 'Nirvana' });
    const r = await harness.callTool('musicbrainz_lookup', {
      entity: 'artist',
      mbid: ARTIST_MBID,
      inc: ['releases', 'release-groups'],
    });
    expect(get).toHaveBeenCalledWith(`/artist/${ARTIST_MBID}`, { inc: 'releases+release-groups' });
    expect(parse(r as never).name).toBe('Nirvana');
  });

  it('lookup omits inc when not provided', async () => {
    get.mockResolvedValueOnce({ id: ARTIST_MBID });
    await harness.callTool('musicbrainz_lookup', { entity: 'release', mbid: ARTIST_MBID });
    expect(get).toHaveBeenCalledWith(`/release/${ARTIST_MBID}`, {});
  });

  it('lookup rejects a non-MBID', async () => {
    const r = await harness.callTool('musicbrainz_lookup', { entity: 'artist', mbid: 'not-a-uuid' });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('search passes query/limit/offset', async () => {
    get.mockResolvedValueOnce({ artists: [] });
    await harness.callTool('musicbrainz_search', { entity: 'artist', query: 'beatles', limit: 5, offset: 10 });
    expect(get).toHaveBeenCalledWith('/artist', { query: 'beatles', limit: 5, offset: 10 });
  });

  it('browse maps linkedBy to the query param', async () => {
    get.mockResolvedValueOnce({ releases: [] });
    await harness.callTool('musicbrainz_browse', {
      entity: 'release',
      linkedBy: 'artist',
      mbid: ARTIST_MBID,
      limit: 100,
    });
    expect(get).toHaveBeenCalledWith('/release', { artist: ARTIST_MBID, limit: 100, offset: undefined });
  });

  it('cover_art calls the CAA client', async () => {
    coverArt.mockResolvedValueOnce({ images: [{ front: true }] });
    const r = await harness.callTool('musicbrainz_cover_art', { entity: 'release', mbid: ARTIST_MBID });
    expect(coverArt).toHaveBeenCalledWith('release', ARTIST_MBID);
    expect(parse(r as never).images).toBeDefined();
  });

  it('resolve extracts entity+mbid from a URL and looks it up', async () => {
    get.mockResolvedValueOnce({ name: 'Radiohead' });
    const r = await harness.callTool('musicbrainz_resolve', {
      url: `https://musicbrainz.org/artist/${ARTIST_MBID}`,
    });
    expect(get).toHaveBeenCalledWith(`/artist/${ARTIST_MBID}`, {});
    const body = parse(r as never);
    expect(body.entity).toBe('artist');
    expect(body.mbid).toBe(ARTIST_MBID);
  });

  it('resolve errors on an unparseable input', async () => {
    const r = await harness.callTool('musicbrainz_resolve', { url: 'https://example.com/foo' });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });

  it('healthcheck reports reachable + oauth status', async () => {
    get.mockResolvedValueOnce({ id: ARTIST_MBID });
    const r = await harness.callTool('musicbrainz_healthcheck', {});
    const body = parse(r as never);
    expect(body.ok).toBe(true);
    expect(body.reachable).toBe(true);
    expect(typeof body.oauth_configured).toBe('boolean');
  });

  it('healthcheck reports unreachable on error', async () => {
    get.mockImplementationOnce(() => Promise.reject(new Error('MusicBrainz unreachable')));
    const r = await harness.callTool('musicbrainz_healthcheck', {});
    const body = parse(r as never);
    expect(body.ok).toBe(false);
    expect(body.reachable).toBe(false);
  });
});

describe('parseMusicBrainzUrl', () => {
  it('parses full URLs, paths, and release-group', () => {
    expect(parseMusicBrainzUrl(`https://musicbrainz.org/release-group/${ARTIST_MBID}`)).toEqual({
      entity: 'release-group',
      mbid: ARTIST_MBID,
    });
    expect(parseMusicBrainzUrl(`artist/${ARTIST_MBID}`)).toEqual({ entity: 'artist', mbid: ARTIST_MBID });
    expect(parseMusicBrainzUrl('nope')).toBeNull();
  });
});
