import { describe, it, expect, afterAll } from 'vitest';
import { registerLookupTools } from '../src/tools/lookup.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerBrowseTools } from '../src/tools/browse.js';
import { registerCoverArtTools } from '../src/tools/coverart.js';
import { registerResolveTools } from '../src/tools/resolve.js';
import { registerUtilityTools } from '../src/tools/utilities.js';
import { registerTagTools } from '../src/tools/tags.js';
import { registerRatingTools } from '../src/tools/ratings.js';
import { registerCollectionTools } from '../src/tools/collections.js';
import { createTestHarness } from './helpers.js';

// Register every tool on an McpServer and verify the full roster via a client.
describe('tool registry', () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('includes all 9 expected tools', async () => {
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

    const tools = await harness.listTools();
    const allNames = tools.map((t) => t.name).sort();

    const expected = [
      'musicbrainz_lookup',
      'musicbrainz_search',
      'musicbrainz_browse',
      'musicbrainz_cover_art',
      'musicbrainz_resolve',
      'musicbrainz_healthcheck',
      'musicbrainz_submit_tags',
      'musicbrainz_submit_rating',
      'musicbrainz_modify_collection',
    ].sort();

    expect(allNames).toEqual(expected);
    expect(tools).toHaveLength(9);
  });
});
