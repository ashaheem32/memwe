import { MemweError } from "@memwe/contracts";
import { type Browser, chromium } from "playwright";

/**
 * One browser per worker process, launched on first use. A Chromium launch
 * costs a second or so and a few hundred megabytes; opening one per fetch
 * would make the browser, not the network, the cost of every URL.
 */
let browser: Promise<Browser> | null = null;

export function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  const channel = process.env["URL_BROWSER_CHANNEL"];
  browser = chromium
    .launch({ headless: true, ...(channel ? { channel } : {}) })
    .catch((err: unknown) => {
      // Do not cache a failed launch: the next fetch should try again, and
      // the most common cause is a browser that was never installed.
      browser = null;
      const message = err instanceof Error ? err.message : String(err);
      throw new MemweError(
        "upstream_failed",
        /executable doesn't exist|Executable doesn't exist/i.test(message)
          ? "headless browser is not installed — run `pnpm exec playwright install chromium` in apps/worker"
          : `headless browser failed to launch: ${message}`,
      );
    });
  return browser;
}

export async function disposeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  if (b) await (await b.catch(() => null))?.close();
}
