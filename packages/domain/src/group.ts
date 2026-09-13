import * as Schema from "effect/Schema";

/**
 * A group = a GitHub public List imported for an indexed user
 * (read-only in v1). `id` is the GitHub GraphQL node id.
 */
export const Group = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  position: Schema.Number,
  repoIds: Schema.Array(Schema.Number)
});
export type Group = typeof Group.Type;
