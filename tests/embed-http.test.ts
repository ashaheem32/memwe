import { afterEach, describe, expect, it, vi } from "vitest";
import { openAICompatible, voyage } from "../apps/worker/src/embed/http.js";
import { assertDimensions } from "../apps/worker/src/embed/provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const vector = () => new Array(1024).fill(0);
describe("embedding HTTP contracts", () => {
  it("uses provider-specific dimension fields and restores indexed response order", async () => {
    for (const p of [
      voyage("fake"),
      openAICompatible("fake", "model", "https://example.invalid/embed"),
    ]) {
      const fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: vector() },
              { index: 0, embedding: new Array(1024).fill(1) },
            ],
          }),
        ),
      );
      vi.stubGlobal("fetch", fetch);
      const out = await p.embed([
        { text: "a", kind: "document" },
        { text: "b", kind: "document" },
      ]);
      expect(out[0]![0]).toBe(1);
      const body = JSON.parse(fetch.mock.calls[0]![1].body);
      if (p.id.startsWith("voyage:")) {
        expect(body.output_dimension).toBe(1024);
        expect(body.dimensions).toBeUndefined();
        expect(body.truncation).toBe(false);
      } else expect(body.dimensions).toBe(1024);
    }
  });
  it("rejects duplicate and out-of-range response indexes", async () => {
    for (const index of [-1, 2, 0.5]) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ data: [{ index, embedding: vector() }] })),
          ),
      );
      await expect(voyage("fake").embed([{ text: "a", kind: "document" }])).rejects.toThrow(
        /index/,
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { index: 0, embedding: vector() },
              { index: 0, embedding: vector() },
            ],
          }),
        ),
      ),
    );
    await expect(
      voyage("fake").embed([
        { text: "a", kind: "document" },
        { text: "b", kind: "document" },
      ]),
    ).rejects.toThrow(/index/);
  });
  it("validates finite vector values", () => {
    const bad = vector();
    bad[0] = Number.NaN;
    expect(() => assertDimensions([bad], 1024, "test")).toThrow();
    expect(() => assertDimensions(new Array(1), 1024, "test")).toThrow();
  });
  it("passes a finite deadline to fetch", async () => {
    vi.stubEnv("EMBED_TIMEOUT_MS", "25");
    const fetch = vi.fn().mockImplementation(async (_url, opts) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      await new Promise((_, reject) =>
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason)),
      );
    });
    vi.stubGlobal("fetch", fetch);
    await expect(voyage("fake").embed([{ text: "a", kind: "document" }])).rejects.toThrow();
  });
});
