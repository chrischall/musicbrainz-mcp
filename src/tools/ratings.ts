import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confirmationFromEnv,
  confirmTokenParam,
  minifiedResult,
  requireConfirmationWithFallback,
  toolAnnotations,
} from '@chrischall/mcp-utils';
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
        'Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE). Nothing is sent before confirmation.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Submit a user rating to MusicBrainz',
        readOnly: false,
        idempotent: true,
        openWorld: true,
        destructive: false,
      }),
      inputSchema: z.object({
        entity: AnnotatableEntitySchema.describe('Entity type to rate'),
        mbid: MbidSchema.describe('MBID of the entity to rate'),
        rating: z
          .number()
          .int()
          .min(0)
          .max(100)
          .describe('Rating 0–100 (0 removes; 20/40/60/80/100 = 1–5 stars)'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ entity, mbid, rating, confirmToken }, ctx) => {
      const xml = buildRatingXml(entity, mbid, rating);
      const gate = await requireConfirmationWithFallback(
        ctx,
        confirmationFromEnv({
          action: 'musicbrainz.submit_rating',
          message:
            rating === 0
              ? 'Review and confirm REMOVING your MusicBrainz rating:'
              : 'Review and confirm this rating on your MusicBrainz account:',
          details: { entity, mbid, rating },
          tool: 'musicbrainz_submit_rating',
          confirmToken,
          subject: () => ({
            target: mbid,
            payload: { method: 'POST', path: '/rating', xml },
            preview: {
              method: 'POST',
              path: '/rating',
              entity,
              mbid,
              rating,
              xml,
              note:
                rating === 0
                  ? 'Confirming will REMOVE your rating.'
                  : 'Confirming will submit this rating to your MusicBrainz account.',
            },
          }),
        })
      );
      if (gate) return gate;
      const response = await client.write('POST', '/rating', { xmlBody: xml });
      return minifiedResult({
        submitted: true,
        entity,
        mbid,
        rating,
        response: response || 'OK',
        note:
          rating === 0
            ? 'Rating removed from your MusicBrainz account.'
            : 'Rating submitted to your MusicBrainz account.',
      });
    }
  );
}
