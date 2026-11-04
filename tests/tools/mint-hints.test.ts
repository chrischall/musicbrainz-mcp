import { describe, it, expect, afterAll } from 'vitest';
import { registerLookupTools } from '../../src/tools/lookup.js';
import { registerSearchTools } from '../../src/tools/search.js';
import { registerBrowseTools } from '../../src/tools/browse.js';
import { registerCoverArtTools } from '../../src/tools/coverart.js';
import { registerResolveTools } from '../../src/tools/resolve.js';
import { registerUtilityTools } from '../../src/tools/utilities.js';
import { registerTagTools } from '../../src/tools/tags.js';
import { registerRatingTools } from '../../src/tools/ratings.js';
import { registerCollectionTools } from '../../src/tools/collections.js';
import { createTestHarness } from '../helpers.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off `tools/list` — what a host actually sees.
 */
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const READ_INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'other'];
const WRITE_INTENTS = ['turn-on-off', 'send', 'change', 'other'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/**
 * The intent every tool declares — this table is the assertion. MusicBrainz is
 * a music encyclopedia: nothing in it is a person's news, due date or
 * schedule, so every read is a lookup and nothing is canonical.
 */
const EXPECTED_INTENT: Record<string, string> = {
  musicbrainz_lookup: 'lookup',
  musicbrainz_search: 'lookup',
  musicbrainz_browse: 'lookup',
  musicbrainz_cover_art: 'lookup',
  musicbrainz_resolve: 'lookup',
  musicbrainz_submit_tags: 'change',
  musicbrainz_submit_rating: 'change',
  musicbrainz_modify_collection: 'change',
};

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let tools: Listed[] = [];
afterAll(async () => {
  if (harness) await harness.close();
});

describe('_meta.mint on tools/list', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerLookupTools(server);
      registerSearchTools(server);
      registerBrowseTools(server);
      registerCoverArtTools(server);
      registerResolveTools(server);
      registerUtilityTools(server);
      registerTagTools(server);
      registerRatingTools(server);
      registerCollectionTools(server);
    });
    tools = (await harness.client.listTools()).tools as Listed[];
  });

  it('names every served tool except the healthcheck, so a new tool cannot skip the decision', () => {
    const hinted = tools.filter((t) => !t.name.endsWith('_healthcheck')).map((t) => t.name);
    expect(hinted.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain family and intent %s', (name, intent) => {
    const mint = tools.find((t) => t.name === name)?._meta?.mint;
    expect(mint, name).toBeDefined();
    expect(mint!.domain).toBe('family');
    expect(mint!.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', () => {
    for (const t of tools) {
      if (t.name.endsWith('_healthcheck')) continue;
      const mint = t._meta!.mint!;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      const readOnly = t.annotations?.readOnlyHint === true;
      expect(readOnly ? READ_INTENTS : WRITE_INTENTS, t.name).toContain(mint.intent);
      if ('canonical' in mint) {
        expect(mint.canonical, t.name).toBe(true);
        expect(readOnly, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(mint.intent);
        expect(props, t.name).toHaveProperty('view');
        expect(props.view.enum, t.name).toContain('brief');
      }
      if ('subject' in mint) expect(props, t.name).toHaveProperty(mint.subject as string);
      if ('when' in mint) {
        const when = mint.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
          expect(a, t.name).not.toMatch(/^musicbrainz_/);
        }
      }
    }
  });

  it('at most one canonical read per whats-new / whats-due / whats-on — and here, none', () => {
    const canonical = tools.filter((t) => t._meta?.mint?.canonical === true);
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter((t) => t._meta!.mint!.intent === intent).length).toBeLessThanOrEqual(1);
    }
    // No music-metadata read answers a what's-new/due/on question, so no
    // canonical read, no brief view and no subject enum.
    expect(canonical.map((t) => t.name)).toEqual([]);
    for (const t of tools) expect(t._meta?.mint?.subject, t.name).toBeUndefined();
  });

  it('carries the words a person says for the reads and the writes', () => {
    const aliases = (name: string) => tools.find((t) => t.name === name)?._meta?.mint?.aliases as string[];
    for (const name of ['musicbrainz_lookup', 'musicbrainz_search', 'musicbrainz_browse']) {
      expect(aliases(name), name).toEqual(expect.arrayContaining(['album', 'artist', 'song']));
    }
    expect(aliases('musicbrainz_cover_art')).toEqual(expect.arrayContaining(['album art', 'cover']));
    expect(aliases('musicbrainz_submit_rating')).toEqual(expect.arrayContaining(['rate', 'stars']));
    expect(aliases('musicbrainz_submit_tags')).toEqual(expect.arrayContaining(['tag', 'genre']));
    expect(aliases('musicbrainz_modify_collection')).toEqual(expect.arrayContaining(['collection']));
  });

  it('leaves the healthcheck unhinted', () => {
    expect(tools.find((t) => t.name === 'musicbrainz_healthcheck')?._meta?.mint).toBeUndefined();
  });
});
