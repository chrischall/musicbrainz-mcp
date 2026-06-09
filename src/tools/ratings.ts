import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { AnnotatableEntitySchema, MbidSchema } from '../entities.js';
import { buildRatingXml } from '../xml.js';
import { ATTRIBUTION_NOTE } from '../attribution.js';

export function registerRatingTools(server: McpServer): void {
  server.registerTool(
    'musicbrainz_submit_rating',
    {
      title: 'Submit a user rating to MusicBrainz',
      description:
        'Set YOUR rating for a MusicBrainz entity (needs OAuth: MUSICBRAINZ_OAUTH_* with the `rating` scope). ' +
        'Rating is 0–100 (MusicBrainz shows it as 1–5 stars in steps of 20; 0 removes your rating). ' +
        'Without confirm: true it returns a dry-run preview and makes NO network call; with confirm: true it submits.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Submit a user rating to MusicBrainz',
        readOnly: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        entity: AnnotatableEntitySchema.describe('Entity type to rate'),
        mbid: MbidSchema.describe('MBID of the entity to rate'),
        rating: z.number().int().min(0).max(100).describe('Rating 0–100 (0 removes; 20/40/60/80/100 = 1–5 stars)'),
        confirm: schemaConfirm,
      },
    },
    async ({ entity, mbid, rating, confirm }) => {
      const xml = buildRatingXml(entity, mbid, rating);
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: 'submit_rating',
          entity,
          mbid,
          rating,
          xml,
          note:
            rating === 0
              ? 'Dry run — re-run with confirm: true to REMOVE your rating.'
              : 'Dry run — re-run with confirm: true to submit this rating to your MusicBrainz account.',
        });
      }
      const response = await client.write('POST', '/rating', { xmlBody: xml });
      return textResult({
        submitted: true,
        entity,
        mbid,
        rating,
        response: response || 'OK',
        note: rating === 0 ? 'Rating removed from your MusicBrainz account.' : 'Rating submitted to your MusicBrainz account.',
      });
    },
  );
}
