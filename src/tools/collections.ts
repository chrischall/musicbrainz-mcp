import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
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
        'Without confirm: true it returns a dry-run preview and makes NO network call; with confirm: true it applies the change.' +
        ATTRIBUTION_NOTE,
      annotations: toolAnnotations({
        title: 'Add or remove entities in a MusicBrainz collection',
        readOnly: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        action: z.enum(['add', 'remove']).describe('Whether to add to or remove from the collection'),
        collection: MbidSchema.describe('MBID of the target collection'),
        entityType: CollectableEntityTypeSchema.describe('Plural entity type the collection holds (e.g. "releases")'),
        mbids: z.array(MbidSchema).min(1).max(100).describe('MBIDs of the entities to add/remove'),
        confirm: schemaConfirm,
      },
    },
    async ({ action, collection, entityType, mbids, confirm }) => {
      const method = action === 'add' ? 'PUT' : 'DELETE';
      const path = `/collection/${collection}/${entityType}/${mbids.join(';')}`;
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: `${action}_collection`,
          method,
          collection,
          entityType,
          mbids,
          note: `Dry run — re-run with confirm: true to ${action} ${mbids.length} ${entityType} ${action === 'add' ? 'to' : 'from'} the collection.`,
        });
      }
      const response = await client.write(method, path);
      return textResult({
        submitted: true,
        action,
        collection,
        entityType,
        mbids,
        response: response || 'OK',
        note: `${mbids.length} ${entityType} ${action === 'add' ? 'added to' : 'removed from'} your MusicBrainz collection.`,
      });
    },
  );
}
