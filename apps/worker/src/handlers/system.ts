import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { StarwatchApi } from "../api.ts";
import { SERVICE_VERSION } from "../constants.ts";
import type { WorkerDeps } from "./types.ts";

export const systemGroup = (_deps: WorkerDeps) =>
  HttpApiBuilder.group(StarwatchApi, "system", (handlers) =>
    handlers.handle("health", () =>
      Effect.succeed({
        ok: true as const,
        service: "starwatch" as const,
        version: SERVICE_VERSION
      })
    )
  );
