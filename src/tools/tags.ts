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
import { buildTagsXml, type TagVote } from '../xml.js';
import { ATTRIBUTION_NOTE } from '../attribution.js';

export function registerTagTools(server: McpServer): void {
  server.registerTool(
    'musicbrainz_submit_tags',
    {
      title: 'Submit user tags to MusicBrainz',
      description:
        'Apply user tags to a MusicBrainz entity on YOUR account (needs OAuth: MUSICBRAINZ_OAUTH_* with the `tag` scope). ' +
        'Default `vote: upvote` adds the tags; `downvote` opposes them; `withdraw` removes your vote. ' +
        'Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE). The preview shows the exact XML; nothing is sent before confirmation.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Submit user tags to MusicBrainz',
        readOnly: false,
        idempotent: true,
        openWorld: true,
        destructive: false,
      }),
      inputSchema: z.object({
        entity: AnnotatableEntitySchema.describe('Entity type to tag'),
        mbid: MbidSchema.describe('MBID of the entity to tag'),
        tags: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .describe('Tag names to apply'),
        vote: z
          .enum(['upvote', 'downvote', 'withdraw'])
          .optional()
          .describe('Vote direction (default upvote)'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ entity, mbid, tags, vote, confirmToken }, ctx) => {
      const v: TagVote = vote ?? 'upvote';
      const xml = buildTagsXml(entity, mbid, tags, v);
      const gate = await requireConfirmationWithFallback(
        ctx,
        confirmationFromEnv({
          action: 'musicbrainz.submit_tags',
          message: `Review and confirm these tags (${v}) on your MusicBrainz account:`,
          details: { entity, mbid, tags: tags.join(', '), vote: v },
          tool: 'musicbrainz_submit_tags',
          confirmToken,
          subject: () => ({
            target: mbid,
            payload: { method: 'POST', path: '/tag', xml },
            preview: {
              method: 'POST',
              path: '/tag',
              entity,
              mbid,
              tags,
              vote: v,
              xml,
              note: 'Confirming will submit these tags to your MusicBrainz account.',
            },
          }),
        })
      );
      if (gate) return gate;
      const response = await client.write('POST', '/tag', { xmlBody: xml });
      return minifiedResult({
        submitted: true,
        entity,
        mbid,
        tags,
        vote: v,
        response: response || 'OK',
        note: 'Tags submitted to your MusicBrainz account.',
      });
    }
  );
}
