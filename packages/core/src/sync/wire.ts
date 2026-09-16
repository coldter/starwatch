/**
 * GitHub wire schemas: REST + GraphQL JSON -> domain types.
 *
 * All key renaming uses `Schema.encodeKeys` (the rc.112 pattern; there is no
 * `Schema.fromKey`). Nested values that flatten onto the domain shape
 * (`owner.login`, `license.spdx_id`) use `Schema.decodeTo`; note the getter
 * direction: `decode` maps pipe-source -> target and `encode` maps back.
 *
 * Decoded types are exactly the `@starwatch/domain` models, so callers never
 * touch snake_case. `starred_at` is not part of a repo object — star pages
 * carry it on the envelope and the client denormalizes it onto `Repo.starredAt`
 * (default `null` here).
 *
 * @see docs/09-public-data-and-limits.md §1–2
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import type { Group } from "@starwatch/domain";

/** `{ login }` -> `login`. */
const OwnerLoginWire = Schema.Struct({ login: Schema.String }).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((owner) => owner.login),
    encode: SchemaGetter.transform((login) => ({ login })),
  }),
);

/** `{ spdx_id } | null` -> `string | null`. */
const LicenseWire = Schema.NullOr(
  Schema.Struct({ spdxId: Schema.NullOr(Schema.String) }).pipe(
    Schema.encodeKeys({ spdxId: "spdx_id" }),
  ),
).pipe(
  Schema.decodeTo(Schema.NullOr(Schema.String), {
    decode: SchemaGetter.transform((license) => license?.spdxId ?? null),
    encode: SchemaGetter.transform((spdxId) => (spdxId === null ? null : { spdxId })),
  }),
);

/** The repo fields a star page carries, decoded straight into `Repo`. */
export const RepoWire = Schema.Struct({
  id: Schema.Number,
  fullName: Schema.String,
  owner: OwnerLoginWire,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  stars: Schema.Number,
  forks: Schema.Number,
  archived: Schema.Boolean,
  license: LicenseWire,
  homepage: Schema.NullOr(Schema.String),
  pushedAt: Schema.NullOr(Schema.String),
  htmlUrl: Schema.String,
  /** Not present on repo objects; the star envelope fills it in. */
  starredAt: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}).pipe(
  Schema.encodeKeys({
    fullName: "full_name",
    stars: "stargazers_count",
    forks: "forks_count",
    pushedAt: "pushed_at",
    htmlUrl: "html_url",
  }),
);

/** One `{ starred_at, repo }` item from `Accept: application/vnd.github.star+json`. */
export const StarItemWire = Schema.Struct({
  starredAt: Schema.String,
  repo: RepoWire,
}).pipe(Schema.encodeKeys({ starredAt: "starred_at" }));

/** `GET /users/{login}` -> `UserProfile`. */
export const UserWire = Schema.Struct({
  login: Schema.String,
  id: Schema.Number,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.String,
  bio: Schema.NullOr(Schema.String),
  company: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  followers: Schema.Number,
  publicRepos: Schema.Number,
  createdAt: Schema.String,
}).pipe(
  Schema.encodeKeys({
    avatarUrl: "avatar_url",
    publicRepos: "public_repos",
    createdAt: "created_at",
  }),
);

/** GraphQL connection cursor state. */
export const PageInfoWire = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

/** `items.nodes` element: the `Repository` member of the `UserListItems` union. */
export const ListItemWire = Schema.Struct({ databaseId: Schema.Number });

export const ItemsConnectionWire = Schema.Struct({
  pageInfo: PageInfoWire,
  nodes: Schema.Array(Schema.NullOr(ListItemWire)),
});

/** `UserList` node as selected by the lists query. */
export const UserListWire = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isPrivate: Schema.Boolean,
  items: ItemsConnectionWire,
});

export const ListsConnectionWire = Schema.Struct({
  pageInfo: PageInfoWire,
  nodes: Schema.Array(UserListWire),
});

/** `data` of the `user(login){ lists { ... } }` query. */
export const UserListsWire = Schema.Struct({
  user: Schema.NullOr(Schema.Struct({ lists: ListsConnectionWire })),
});

/** `data` of the `node(id){ ... on UserList { items { ... } } }` continuation. */
export const ListItemsPageWire = Schema.Struct({
  node: Schema.NullOr(Schema.Struct({ items: ItemsConnectionWire })),
});

/** GraphQL error entry (only `message` is load-bearing for us). */
export const GraphqlErrorWire = Schema.Struct({ message: Schema.String });

/** GraphQL envelope; `data` stays unknown so it can be decoded per query. */
export const GraphqlEnvelopeWire = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.Array(GraphqlErrorWire)),
});

export const decodeRepo = Schema.decodeUnknownEffect(RepoWire);

export const decodeUserProfile = Schema.decodeUnknownEffect(UserWire);

export const decodeStarItems = Schema.decodeUnknownEffect(Schema.Array(StarItemWire));

export const decodeUserLists = Schema.decodeUnknownEffect(UserListsWire);

export const decodeListItemsPage = Schema.decodeUnknownEffect(ListItemsPageWire);

export const decodeGraphqlEnvelope = Schema.decodeUnknownEffect(GraphqlEnvelopeWire);

/**
 * Turn a GitHub List name into a stable slug: lowercase, every run of
 * non-alphanumerics becomes one `-`, leading/trailing dashes dropped.
 * `"Rust / Tools & More"` -> `"rust-tools-more"`.
 */
export const slugifyGroupName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** One decoded `UserList` node (see {@link UserListWire}). */
export type UserListWireType = (typeof UserListWire)["Type"];

/**
 * Map a decoded `UserList` node to a domain {@link Group}. `extraRepoIds`
 * carries item-continuation pages; the node's first page is included in order.
 */
export const groupFromUserList = (
  node: UserListWireType,
  position: number,
  extraRepoIds: ReadonlyArray<number> = [],
): Group => ({
  id: node.id,
  name: node.name,
  slug: slugifyGroupName(node.name),
  position,
  repoIds: [
    ...node.items.nodes.flatMap((item) => (item === null ? [] : [item.databaseId])),
    ...extraRepoIds,
  ],
});
