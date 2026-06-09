import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { CoreEntitySchema, MbidSchema } from '../entities.js';
import { ATTRIBUTION_NOTE } from '../attribution.js';

export function registerLookupTools(server: McpServer): void {
  server.registerTool(
    'musicbrainz_lookup',
    {
      title: 'Look up a MusicBrainz entity by MBID',
      description:
        'Fetch a single MusicBrainz entity (artist, release, recording, release-group, label, work, area, place, event, instrument, series, genre, url) by its MBID. ' +
        'Use `inc` to pull linked sub-entities and relationships, e.g. inc: ["releases","release-groups"] on an artist, or ["recordings","labels"] on a release, or ["artist-credits","url-rels"] on most entities. ' +
        'Read-only.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Look up a MusicBrainz entity by MBID',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        entity: CoreEntitySchema.describe('Entity type to look up'),
        mbid: MbidSchema.describe('The entity MBID (UUID)'),
        inc: z
          .array(z.string())
          .optional()
          .describe('Subqueries/relationships to include, e.g. ["releases","url-rels","tags"]'),
      },
    },
    async ({ entity, mbid, inc }) => {
      const query = inc && inc.length > 0 ? { inc: inc.join('+') } : {};
      const data = await client.get(`/${entity}/${encodeURIComponent(mbid)}`, query);
      return textResult(data);
    },
  );
}
