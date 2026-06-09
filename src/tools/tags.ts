import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
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
        'Without confirm: true it returns a dry-run preview (the exact XML) and makes NO network call; with confirm: true it submits.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Submit user tags to MusicBrainz',
        readOnly: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        entity: AnnotatableEntitySchema.describe('Entity type to tag'),
        mbid: MbidSchema.describe('MBID of the entity to tag'),
        tags: z.array(z.string().min(1)).min(1).max(50).describe('Tag names to apply'),
        vote: z.enum(['upvote', 'downvote', 'withdraw']).optional().describe('Vote direction (default upvote)'),
        confirm: schemaConfirm,
      },
    },
    async ({ entity, mbid, tags, vote, confirm }) => {
      const v: TagVote = vote ?? 'upvote';
      const xml = buildTagsXml(entity, mbid, tags, v);
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: 'submit_tags',
          entity,
          mbid,
          tags,
          vote: v,
          xml,
          note: 'Dry run — re-run with confirm: true to submit these tags to your MusicBrainz account.',
        });
      }
      const response = await client.write('POST', '/tag', { xmlBody: xml });
      return textResult({
        submitted: true,
        entity,
        mbid,
        tags,
        vote: v,
        response: response || 'OK',
        note: 'Tags submitted to your MusicBrainz account.',
      });
    },
  );
}
