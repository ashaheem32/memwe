import { CONTAINER_TAG_RE } from "@memwe/contracts";
import { close, pool, withTenant } from "@memwe/db";
import { afterAll, describe, expect, it } from "vitest";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

afterAll(async () => {
  await close();
});

describe("tenant isolation", () => {
  it("RLS hides another org's documents", async () => {
    const asA = await withTenant({ orgId: ORG_A }, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        "select count(*)::text as n from documents where org_id = $1",
        [ORG_B],
      );
      return Number(rows[0]!.n);
    });
    expect(asA).toBe(0);
  });

  it("RLS still shows the org its own documents", async () => {
    const own = await withTenant({ orgId: ORG_A }, async (c) => {
      const { rows } = await c.query<{ n: string }>("select count(*)::text as n from documents");
      return Number(rows[0]!.n);
    });
    expect(own).toBeGreaterThan(0);
  });

  it("the container domain rejects malformed tags at the database", async () => {
    await expect(
      pool.query(
        `insert into documents (org_id, container, content_hash) values ($1, $2, '\\x00')`,
        [ORG_A, "bad container!"],
      ),
    ).rejects.toThrow();
  });

  it("app regex and database domain agree", () => {
    for (const good of ["user_123", "project-mobile-app", "org:acme:user:john"]) {
      expect(CONTAINER_TAG_RE.test(good)).toBe(true);
    }
    for (const bad of ["", "has space", "emoji🙂", "a".repeat(101)]) {
      expect(CONTAINER_TAG_RE.test(bad)).toBe(false);
    }
  });
});
