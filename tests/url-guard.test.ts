import { assertFetchableUrl, isPrivateAddress, MemweError } from "@memwe/contracts";
import { describe, expect, it } from "vitest";
import { assertPublicHost } from "../apps/worker/src/fetch/guard.js";

describe("url policy (contracts)", () => {
  it("accepts ordinary public http(s) URLs", () => {
    expect(assertFetchableUrl("https://example.com/a?b=1").href).toBe("https://example.com/a?b=1");
    expect(assertFetchableUrl("http://93.184.216.34/").hostname).toBe("93.184.216.34");
  });

  it("refuses everything that is not a plain http(s) fetch", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "javascript:alert(1)",
      "https://user:pw@example.com/",
      "not a url",
    ]) {
      expect(() => assertFetchableUrl(url)).toThrow(MemweError);
    }
  });

  it("refuses literal private, loopback, link-local and metadata addresses", () => {
    for (const host of [
      "localhost",
      "foo.localhost",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.9.9",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "[::1]",
      "[fe80::1]",
      "[fc00::1]",
      "[fd12:3456::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:10.0.0.1]",
      "[64:ff9b::7f00:1]",
    ]) {
      expect(() => assertFetchableUrl(`http://${host}/`), host).toThrow(/not public/);
    }
    expect(() => assertFetchableUrl("http://172.32.0.1/")).not.toThrow();
    expect(() => assertFetchableUrl("http://[2606:4700::1111]/")).not.toThrow();
  });

  it("can be told to allow private hosts for development", () => {
    expect(assertFetchableUrl("http://127.0.0.1:8080/", { allowPrivate: true }).port).toBe("8080");
  });

  it("treats anything that is not an address as unsafe", () => {
    expect(isPrivateAddress("example.com")).toBe(true);
    expect(isPrivateAddress("300.1.1.1")).toBe(true);
  });
});

describe("host guard (worker)", () => {
  it("resolves names and refuses when any answer is private", async () => {
    const lookup = async (host: string) =>
      ({
        "public.test": ["93.184.216.34"],
        "rebind.test": ["93.184.216.34", "10.0.0.1"],
        "loop.test": ["127.0.0.1"],
        "six.test": ["2606:4700::1111"],
        "mapped.test": ["::ffff:169.254.169.254"],
      })[host] ?? [];
    await expect(assertPublicHost("public.test", { lookup })).resolves.toEqual(["93.184.216.34"]);
    await expect(assertPublicHost("six.test", { lookup })).resolves.toEqual(["2606:4700::1111"]);
    await expect(assertPublicHost("rebind.test", { lookup })).rejects.toThrow(/private/);
    await expect(assertPublicHost("loop.test", { lookup })).rejects.toThrow(/private/);
    await expect(assertPublicHost("mapped.test", { lookup })).rejects.toThrow(/private/);
    await expect(assertPublicHost("nowhere.test", { lookup })).rejects.toThrow(/did not resolve/);
    await expect(assertPublicHost("localhost", { lookup })).rejects.toThrow(/not public/);
  });

  it("checks literal addresses without a lookup", async () => {
    await expect(assertPublicHost("93.184.216.34")).resolves.toEqual(["93.184.216.34"]);
    await expect(assertPublicHost("169.254.169.254")).rejects.toThrow(/not public/);
    await expect(assertPublicHost("[::1]")).rejects.toThrow(/not public/);
    await expect(assertPublicHost("127.0.0.1", { allowPrivate: true })).resolves.toEqual([
      "127.0.0.1",
    ]);
  });
});
