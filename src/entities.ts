import { z } from 'zod';

// The 13 core MusicBrainz entities addressable by MBID via lookup/search/browse.
// See docs/MUSICBRAINZ-API.md.
export const CORE_ENTITIES = [
  'area',
  'artist',
  'event',
  'genre',
  'instrument',
  'label',
  'place',
  'recording',
  'release',
  'release-group',
  'series',
  'work',
  'url',
] as const;

export type CoreEntity = (typeof CORE_ENTITIES)[number];

export const CoreEntitySchema = z.enum(CORE_ENTITIES);

// Entities that carry an MBID and so can be searched. (Search also indexes
// annotation/cdstub/tag, which aren't MBID entities — omitted to keep lookups
// and searches over one consistent enum.)
export const SEARCHABLE_ENTITIES = CORE_ENTITIES.filter((e) => e !== 'url');
export const SearchableEntitySchema = z.enum(SEARCHABLE_ENTITIES as [string, ...string[]]);

// Entities that accept user tags and ratings. (`genre` is itself a tag and
// `url` is not user-annotatable, so both are excluded.)
export const ANNOTATABLE_ENTITIES = CORE_ENTITIES.filter((e) => e !== 'url' && e !== 'genre');
export const AnnotatableEntitySchema = z.enum(ANNOTATABLE_ENTITIES as [string, ...string[]]);

// Plural entity-type segments used in collection PUT/DELETE paths.
export const COLLECTABLE_ENTITY_TYPES = [
  'areas',
  'artists',
  'events',
  'labels',
  'places',
  'recordings',
  'releases',
  'release-groups',
  'works',
] as const;

export const CollectableEntityTypeSchema = z.enum(COLLECTABLE_ENTITY_TYPES);

/** A MusicBrainz MBID is a canonical UUID. */
export const MbidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a MusicBrainz MBID (UUID)');
