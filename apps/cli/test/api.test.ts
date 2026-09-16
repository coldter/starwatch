import { describe, expect, it } from "@effect/vitest";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { ApiError, CliInputError, NoResultsError, mapHttpError } from "../src/api.ts";

const UserNotFoundBody = Schema.TaggedStruct("UserNotFound", { message: Schema.String });

const SyncInProgressBody = Schema.TaggedStruct("SyncInProgress", {});

describe("mapHttpError", () => {
  it("explains 404s for users and repos", () => {
    const user = mapHttpError(404, "", { login: "alice" });
    expect(user.code).toBe("NOT_FOUND");
    expect(user.message).toBe('No GitHub user named "alice".');
    expect(user.hint).toContain("spelling");

    const repo = mapHttpError(404, "", { repo: "o/nope" });
    expect(repo.code).toBe("NOT_FOUND");
    expect(repo.message).toBe('Repository "o/nope" is not indexed.');
  });

  it("prefers the API message when the body carries one", () => {
    const body = JSON.stringify({
      error: UserNotFoundBody.make({ message: "Could not resolve @ghost" }),
    });

    expect(mapHttpError(404, body, {}).message).toBe("Could not resolve @ghost");
  });

  it("turns sync 429s into attach/cooldown guidance", () => {
    const inProgress = mapHttpError(429, JSON.stringify({ error: SyncInProgressBody.make({}) }), {
      login: "alice",
    });

    expect(inProgress.code).toBe("RATE_LIMITED");
    expect(inProgress.message).toContain("already running");
    expect(inProgress.hint).toContain("starwatch sync alice --wait");

    const cooldown = mapHttpError(
      429,
      JSON.stringify({ error: { code: "SyncCooldown", retryAfterSeconds: 90 } }),
      { login: "alice" },
    );

    expect(cooldown.hint).toContain("90s");
  });

  it("handles generic 429s, conflicts, bad requests and server errors", () => {
    expect(mapHttpError(429, "", {}).hint).toContain("Wait a moment");
    expect(mapHttpError(409, "", {}).code).toBe("CONFLICT");
    expect(mapHttpError(400, "", {}).code).toBe("BAD_REQUEST");
    expect(mapHttpError(503, "", {}).code).toBe("SERVER");
    expect(mapHttpError(418, "", {}).message).toContain("HTTP 418");
  });

  it("survives non-JSON bodies", () => {
    const info = mapHttpError(500, "<html>Oops</html>", {});
    expect(info.code).toBe("SERVER");
    expect(info.message).toContain("HTTP 500");
  });
});

describe("exit-code markers", () => {
  it("maps NoResults to 2 and everything else to 1", () => {
    expect(Runtime.getErrorExitCode(new NoResultsError({ query: "x" }))).toBe(2);
    expect(Runtime.getErrorExitCode(new ApiError({ code: "NETWORK", message: "down" }))).toBe(1);
    expect(Runtime.getErrorExitCode(new CliInputError({ message: "bad" }))).toBe(1);
  });

  it("suppresses duplicate runtime logging for already-reported errors", () => {
    expect(Runtime.getErrorReported(new NoResultsError({ query: "x" }))).toBe(false);
    expect(Runtime.getErrorReported(new ApiError({ code: "SERVER", message: "boom" }))).toBe(false);
    expect(Runtime.getErrorReported(new CliInputError({ message: "bad" }))).toBe(false);
  });
});
