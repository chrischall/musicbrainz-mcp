import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { SearchableEntitySchema } from '../entities.js';
import { ATTRIBUTION_NOTE } from '../attribution.js';

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    'musicbrainz_search',
    {
      title: 'Search MusicBrainz',
      description:
        'Search a MusicBrainz entity type with a Lucene query and get back ranked matches with their MBIDs. ' +
        'Plain text matches the entity name; fielded Lucene also works, e.g. `artist:"Miles Davis" AND country:US`, ' +
        '`release:"Kind of Blue" AND format:Vinyl`, or `recording:"So What" AND dur:[540000 TO 560000]`. ' +
        'Feed a returned MBID into musicbrainz_lookup for full detail. Read-only.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Search MusicBrainz',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        entity: SearchableEntitySchema.describe('Entity type to search'),
        query: z.string().min(1).describe('Lucene query string (plain text or fielded)'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (1–100, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
      },
    },
    async ({ entity, query, limit, offset }) => {
      const data = await client.get(`/${entity}`, { query, limit, offset });
      return textResult(data);
    },
  );
}
