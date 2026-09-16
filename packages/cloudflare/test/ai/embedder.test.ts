import { describe, expect, it } from "@effect/vitest";
import type { Repo } from "@starwatch/domain";
import { EmbedFailed } from "@starwatch/core/sync";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  EMBEDDING_MODEL,
  batchTexts,
  makeWorkersAiEmbedder,
  repoEmbeddingText
} from "../../src/ai/embedder.ts";

const repo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 1,
  fullName: "owner/name",
  owner: "owner",
  name: "name",
  description: null,
  language: null,
  topics: [],
  stars: 0,
  forks: 0,
  archived: false,
  license: null,
  homepage: null,
  pushedAt: null,
  starredAt: null,
  htmlUrl: "https://github.com/owner/name",
  ...overrides
});

interface FakeBindingOptions {
  readonly delayMs?: number;
  readonly fail?: boolean;
  readonly data?: (batch: ReadonlyArray<string>) => ReadonlyArray<ReadonlyArray<number>>;
}

const fakeBinding = (options: FakeBindingOptions = {}) => {
  const calls: Array<{ model: string; texts: ReadonlyArray<string> }> = [];
  let active = 0;
  let maxActive = 0;

  const binding = {
    run: async (model: string, input: { readonly text: ReadonlyArray<string> }) => {
      calls.push({ model, texts: input.text });
      active += 1;
      maxActive = Math.max(maxActive, active);

      try {
        if (options.delayMs !== undefined) {
          await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
        }

        if (options.fail === true) throw new Error("workers ai unavailable");

        const data =
          options.data?.(input.text) ??
          input.text.map((text, index) => [Number(text), index * 0.5]);

        return { data };
      } finally {
        active -= 1;
      }
    }
  };

  return { binding, calls, peakConcurrency: () => maxActive };
};

describe("batchTexts", () => {
  it("splits into fixed-size batches with a short tail", () => {
    expect(batchTexts(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("returns no batches for empty input and one batch when small enough", () => {
    expect(batchTexts([], 32)).toEqual([]);
    expect(batchTexts(["a"], 32)).toEqual([["a"]]);
  });

  it("rejects non-positive sizes", () => {
    expect(() => batchTexts(["a"], 0)).toThrow(RangeError);
    expect(() => batchTexts(["a"], -1)).toThrow(RangeError);
  });
});

describe("repoEmbeddingText", () => {
  it("builds the documented document profile", () => {
    const text = repoEmbeddingText(
      repo({
        fullName: "Effect-TS/effect",
        description: "An ecosystem of tools",
        topics: ["typescript", "functional-programming"],
        language: "TypeScript"
      }),
      "  # Effect\n\nA   library for effectful programs.  "
    );

    expect(text).toBe(
      "Effect-TS/effect — An ecosystem of tools\n" +
        "Topics: typescript, functional-programming\n" +
        "Language: TypeScript\n" +
        "# Effect A library for effectful programs."
    );
  });

  it("drops empty optional lines", () => {
    expect(repoEmbeddingText(repo(), null)).toBe("owner/name");
    expect(repoEmbeddingText(repo({ language: "" }), "   ")).toBe("owner/name");
    expect(repoEmbeddingText(repo({ description: "  " }), undefined)).toBe("owner/name");
  });

  it("caps the README excerpt", () => {
    const text = repoEmbeddingText(repo(), "0123456789", { maxChars: 4 });
    expect(text).toBe("owner/name\n0123");
  });
});

describe("makeWorkersAiEmbedder", () => {
  it("batches in order and returns vectors in input order", async () => {
    const fake = fakeBinding();
    const embedder = makeWorkersAiEmbedder(fake.binding, { batchSize: 2, concurrency: 2 });
    const vectors = await Effect.runPromise(embedder.embed(["0", "1", "2", "3", "4"]));
    expect(fake.calls.map((call) => call.texts.length)).toEqual([2, 2, 1]);
    expect(fake.calls.every((call) => call.model === EMBEDDING_MODEL)).toBe(true);
    expect(vectors).toHaveLength(5);
    expect(vectors.map((vector) => vector[0])).toEqual([0, 1, 2, 3, 4]);
  });

  it("does not call Workers AI for an empty input", async () => {
    const fake = fakeBinding();
    const embedder = makeWorkersAiEmbedder(fake.binding);
    const vectors = await Effect.runPromise(embedder.embed([]));
    expect(vectors).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps in-flight batches at the concurrency limit", async () => {
    const fake = fakeBinding({ delayMs: 10 });
    const embedder = makeWorkersAiEmbedder(fake.binding, { batchSize: 2, concurrency: 2 });
    const vectors = await Effect.runPromise(embedder.embed(["0", "1", "2", "3", "4", "5", "6", "7"]));
    expect(vectors).toHaveLength(8);
    expect(fake.calls).toHaveLength(4);
    expect(fake.peakConcurrency()).toBeLessThanOrEqual(2);
    expect(fake.peakConcurrency()).toBe(2);
  });

  it("wraps binding failures in EmbedFailed", async () => {
    const fake = fakeBinding({ fail: true });
    const embedder = makeWorkersAiEmbedder(fake.binding, { batchSize: 4 });
    const result = await Effect.runPromise(Effect.result(embedder.embed(["a"])));
    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(EmbedFailed);
      expect(result.failure.message).toContain("Workers AI embedding batch");
    }
  });

  it("rejects a row-count mismatch from the binding", async () => {
    const fake = fakeBinding({ data: () => [[1, 2, 3]] });
    const embedder = makeWorkersAiEmbedder(fake.binding, { batchSize: 4 });
    const result = await Effect.runPromise(Effect.result(embedder.embed(["a", "b"])));
    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(EmbedFailed);
      expect(result.failure.message).toContain("1 embeddings for 2 texts");
    }
  });

  it("rejects invalid construction options", () => {
    const fake = fakeBinding();
    expect(() => makeWorkersAiEmbedder(fake.binding, { batchSize: 0 })).toThrow(RangeError);
    expect(() => makeWorkersAiEmbedder(fake.binding, { concurrency: -1 })).toThrow(RangeError);
  });
});
