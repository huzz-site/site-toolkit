import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSiteConfig, loadWranglerConfig, writeWorkspaceConfig } from "../src/config.js";
import { SiteError } from "../src/errors.js";

const directories: string[] = [];

async function target(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "site-config-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("configuration", () => {
  it("writes workspace configuration atomically", async () => {
    const directory = await target();
    await writeWorkspaceConfig(directory, {
      schemaVersion: 1,
      organization: "huzz-site",
      cloudflare: { accountId: "account-123", accountName: "Default" },
    });
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(join(directory, ".site-workspace.json"), "utf8"));
    expect(raw.cloudflare.accountId).toBe("account-123");
  });

  it("rejects invalid site configuration", async () => {
    const directory = await target();
    await writeFile(join(directory, "site.config.json"), '{"version":1,"id":"INVALID"}');
    await expect(loadSiteConfig(directory)).rejects.toMatchObject<Partial<SiteError>>({ code: "SITE_CONFIG_INVALID" });
  });

  it("accepts JSONC Wrangler configuration", async () => {
    const directory = await target();
    await writeFile(
      join(directory, "wrangler.jsonc"),
      '{ "name": "demo", "account_id": "a", "compatibility_date": "2026-09-12", "assets": { "not_found_handling": "single-page-application" }, }',
    );
    await expect(loadWranglerConfig(directory)).resolves.toMatchObject({ name: "demo", account_id: "a" });
  });
});
