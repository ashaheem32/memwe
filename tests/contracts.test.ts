import { IngestRequest, Tenant, UploadRequest } from "@memwe/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Regression: zod 4's z.uuid() enforces RFC 9562 version and variant
 * nibbles. Postgres will happily store — and uuid_generate_v4 is not the
 * only thing that produces — UUID-shaped values that fail that check, and
 * our own fixtures did. Identifiers here are opaque, so the contracts use
 * z.guid(). If someone "tidies" that back to z.uuid(), this fails.
 */
describe("identifier validation", () => {
  const shaped = [
    "11111111-1111-1111-1111-111111111111", // fixture id: variant nibble is 1
    "00000000-0000-0000-0000-000000000000", // nil
    "2f736631-bb76-4429-9e02-0ece254efd9e", // a real v4
  ];

  it("accepts every UUID-shaped identifier, not just RFC 9562 v4", () => {
    for (const id of shaped) {
      expect(Tenant.safeParse({ orgId: id, container: "user_x" }).success).toBe(true);
    }
  });

  it("still rejects things that are not UUID-shaped", () => {
    for (const bad of ["", "not-a-uuid", "11111111-1111-1111-1111-11111111111"]) {
      expect(Tenant.safeParse({ orgId: bad, container: "user_x" }).success).toBe(false);
    }
  });

  it("z.uuid() would have rejected our own fixtures — documenting why we use guid", () => {
    expect(z.uuid().safeParse(shaped[0]).success).toBe(false);
    expect(z.guid().safeParse(shaped[0]).success).toBe(true);
  });
});

describe("request schemas", () => {
  it("rejects a malformed container tag", () => {
    expect(IngestRequest.safeParse({ container: "bad tag!", content: "x" }).success).toBe(false);
  });

  it("caps text at the 1MB documented limit", () => {
    expect(
      IngestRequest.safeParse({ container: "user_x", content: "a".repeat(1_000_001) }).success,
    ).toBe(false);
  });

  it("names its schemas so the OpenAPI document emits components", () => {
    // Anonymous inline schemas produce SDKs full of unnamed types.
    expect(z.toJSONSchema(IngestRequest, { io: "input" })).toBeTruthy();
    expect(IngestRequest.meta()?.id).toBe("IngestRequest");
    expect(UploadRequest.meta()?.id).toBe("UploadRequest");
  });
});
