import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { CoreEntitySchema, MbidSchema } from '../entities.js';
import { ATTRIBUTION_NOTE } from '../attribution.js';

// Common entities you can browse *by* (the linking relationship). MusicBrainz
// validates the actual combination; this list drives the schema + a good error.
const LINK_ENTITIES = [
  'area',
  'artist',
  'collection',
  'event',
  'label',
  'place',
  'recording',
  'release',
  'release-group',
  'series',
  'track',
  'track_artist',
  'work',
] as const;

export function registerBrowseTools(server: McpServer): void {
  server.registerTool(
    'musicbrainz_browse',
    {
      title: 'Browse MusicBrainz entities linked to another',
      description:
        'List all entities of one type directly linked to a given entity — e.g. every release by an artist ' +
        '(entity: "release", linkedBy: "artist", mbid: <artist>), recordings on a release, releases in a collection, or events at a place. ' +
        'This is the complete, paged set for a relationship (unlike search, which ranks fuzzy matches). ' +
        'Use `inc` for extra detail and limit/offset to page (max 100/page). Read-only.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Browse MusicBrainz entities linked to another',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        entity: CoreEntitySchema.describe('Result entity type to list'),
        linkedBy: z.enum(LINK_ENTITIES).describe('The relationship to browse by (the linking entity type)'),
        mbid: MbidSchema.describe('MBID of the linking entity'),
        inc: z.array(z.string()).optional().describe('Subqueries to include, e.g. ["labels","recordings"]'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (1–100, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
      },
    },
    async ({ entity, linkedBy, mbid, inc, limit, offset }) => {
      const query: Record<string, string | number | undefined> = {
        [linkedBy]: mbid,
        limit,
        offset,
      };
      if (inc && inc.length > 0) query.inc = inc.join('+');
      const data = await client.get(`/${entity}`, query);
      return textResult(data);
    },
  );
}
