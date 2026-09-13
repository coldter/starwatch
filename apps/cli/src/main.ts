import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";

/**
 * starwatch CLI.
 * v1 targets: `search`, `show`, `sync` — currently stubs that print arguments.
 * All commands will talk to the deployed Worker over Effect RPC.
 */

const search = Command.make(
  "search",
  {
    query: Argument.string("query"),
    language: Flag.string("lang").pipe(Flag.withDefault("")),
    minStars: Flag.integer("min-stars").pipe(Flag.withDefault(0)),
    limit: Flag.integer("limit").pipe(Flag.withDefault(10))
  },
  ({ query, language, minStars, limit }) =>
    Effect.log(
      `TODO search: query="${query}" lang="${language}" min-stars=${minStars} limit=${limit}`
    )
);

const show = Command.make("show", { repo: Argument.string("repo") }, ({ repo }) =>
  Effect.log(`TODO show: ${repo}`)
);

const sync = Command.make("sync", {}, () => Effect.log("TODO sync"));

const cli = Command.make("starwatch", {}, () =>
  Effect.log("starwatch — run with --help")
).pipe(Command.withSubcommands([search, show, sync]));

export const main = Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer)
);

NodeRuntime.runMain(main);
