import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { MbidSchema } from '../entities.js';
import { ATTRIBUTION_NOTE } from '../attribution.js';

// NO `view` on this tool, deliberately. Its product IS the image URLs: compact
// strips `images`/`thumbnails`, which here does not shrink the response, it
// EMPTIES it. Same rule as alltrails' photo tools, sw_get_receipt and redfin's
// photo bundles — see @chrischall/mcp-utils' `stripMediaUrls` docs.
export function registerCoverArtTools(server: McpServer): void {
  server.registerTool(
    'musicbrainz_cover_art',
    {
      title: 'Get Cover Art Archive images for a release',
      description:
        'Fetch Cover Art Archive image metadata for a release or release-group MBID — front/back cover URLs, ' +
        'thumbnails, and image types. Returns the image URLs (you can open or download them); it does not embed the bytes. ' +
        'Errors clearly when no art exists for the MBID. Read-only.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Get Cover Art Archive images for a release',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        entity: z.enum(['release', 'release-group']).describe('Which MBID type the cover art is keyed on'),
        mbid: MbidSchema.describe('Release or release-group MBID'),
      },
    },
    async ({ entity, mbid }) => {
      const data = await client.coverArt(entity, mbid);
      return minifiedResult(data);
    },
  );
}
