import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Command from "alchemy/Command";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Worker from "./src/worker.ts";

/**
 * Stack entrypoint. `alchemy plan | deploy | dev | destroy` load this file's
 * default export.
 */
const webuiDir = fileURLToPath(new URL("../webui", import.meta.url));

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

    // The WebUI dev server joins the `alchemy dev` loop: started with the
    // stack, its logs mirrored, restarted when inputs change, and a no-op on
    // plan/deploy (see https://v2.alchemy.run/command/dev-servers).
    const web = yield* Command.Dev("Web", {
      command: "pnpm run dev",
      cwd: webuiDir
    });

    return {
      apiUrl: worker.url,
      webUrl: web.url
    };
  })
);
