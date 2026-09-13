import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Worker from "./src/worker.ts";

/**
 * Stack entrypoint. `alchemy plan | deploy | dev | destroy` load this file's
 * default export.
 */
export default Alchemy.Stack(
  "Starwatch",
  {
    providers: Cloudflare.providers(),
    // Local state file under <cwd>/.alchemy/state/... ; swap for
    // `Cloudflare.state()` once we want remote/shared state.
    state: Alchemy.localState()
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return {
      url: worker.url
    };
  })
);
