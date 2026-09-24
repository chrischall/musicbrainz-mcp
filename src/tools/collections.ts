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
import { CollectableEntityTypeSchema, MbidSchema } from '../entities.js';
import { ATTRIBUTION_NOTE } from '../attribution.js';

export function registerCollectionTools(server: McpServer): void {
  server.registerTool(
    'musicbrainz_modify_collection',
    {
      title: 'Add or remove entities in a MusicBrainz collection',
      description:
        'Add or remove entities (releases, artists, recordings, release-groups, works, labels, places, areas, events) ' +
        'in one of YOUR MusicBrainz collections (needs OAuth: MUSICBRAINZ_OAUTH_* with the `collection` scope). ' +
        'Get the collection MBID from its URL (musicbrainz.org/collection/<mbid>). ' +
        'Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE). Nothing is changed before confirmation.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Add or remove entities in a MusicBrainz collection',
        readOnly: false,
        idempotent: true,
        openWorld: true,
        destructive: false,
      }),
      inputSchema: z.object({
        action: z
          .enum(['add', 'remove'])
          .describe('Whether to add to or remove from the collection'),
        collection: MbidSchema.describe('MBID of the target collection'),
        entityType: CollectableEntityTypeSchema.describe(
          'Plural entity type the collection holds (e.g. "releases")'
        ),
        mbids: z
          .array(MbidSchema)
          .min(1)
          .max(100)
          .describe('MBIDs of the entities to add/remove'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ action, collection, entityType, mbids, confirmToken }, ctx) => {
      const method = action === 'add' ? 'PUT' : 'DELETE';
      const path = `/collection/${collection}/${entityType}/${mbids.join(';')}`;
      const effect = `${action} ${mbids.length} ${entityType} ${action === 'add' ? 'to' : 'from'} the collection`;
      const gate = await requireConfirmationWithFallback(
        ctx,
        confirmationFromEnv({
          action: `musicbrainz.${action}_collection`,
          message: `Review and confirm: ${effect}.`,
          details: { action, collection, entityType, mbids: mbids.join(', ') },
          tool: 'musicbrainz_modify_collection',
          confirmToken,
          subject: () => ({
            target: collection,
            payload: { method, path },
            preview: {
              action: `${action}_collection`,
              method,
              path,
              collection,
              entityType,
              mbids,
              note: `Confirming will ${effect}.`,
            },
          }),
        })
      );
      if (gate) return gate;
      const response = await client.write(method, path);
      return minifiedResult({
        submitted: true,
        action,
        collection,
        entityType,
        mbids,
        response: response || 'OK',
        note: `${mbids.length} ${entityType} ${action === 'add' ? 'added to' : 'removed from'} your MusicBrainz collection.`,
      });
    }
  );
}
