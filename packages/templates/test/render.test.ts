import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderVueTemplate } from "../src/index.js";

const directories: string[] = [];

async function target(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "site-template-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("renderVueTemplate", () => {
  it("renders one Worker containing Vue and an API", async () => {
    const directory = await target();
    await renderVueTemplate({
      targetDirectory: directory,
      repository: "huzz.cn",
      siteId: "huzz-cn",
      displayName: "弧之舟",
      accountId: "account-123",
      domain: "huzz.cn",
      aliases: ["www.huzz.cn"],
      withBackend: true,
      compatibilityDate: "2026-09-12",
    });

    const site = JSON.parse(await readFile(join(directory, "site.config.json"), "utf8")) as Record<string, unknown>;
    const wrangler = JSON.parse(await readFile(join(directory, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
    const workflow = await readFile(join(directory, ".github/workflows/deploy.yml"), "utf8");
    const worker = await readFile(join(directory, "server/index.ts"), "utf8");

    expect(site).toMatchObject({ id: "huzz-cn", displayName: "弧之舟", template: "vue" });
    expect(wrangler).toMatchObject({ name: "huzz-cn", account_id: "account-123", main: "server/index.ts" });
    expect(wrangler.assets).toMatchObject({ run_worker_first: ["/api/*"] });
    expect(wrangler.routes).toEqual([
      { pattern: "huzz.cn", custom_domain: true },
      { pattern: "www.huzz.cn", custom_domain: true },
    ]);
    expect(workflow).toContain("huzz-site/site-toolkit/.github/workflows/deploy.yml@v1");
    expect(workflow).toContain("cloudflare-account-id");
    expect(worker).toContain("satisfies ExportedHandler<Env>");
  });

  it("removes backend-only files for an assets-only site", async () => {
    const directory = await target();
    await renderVueTemplate({
      targetDirectory: directory,
      repository: "example.com",
      siteId: "example-com",
      displayName: "Example",
      accountId: "account-123",
      domain: "example.com",
      aliases: [],
      withBackend: false,
    });

    const { access } = await import("node:fs/promises");
    await expect(access(join(directory, "server/index.ts"))).rejects.toThrow();
    const wrangler = JSON.parse(await readFile(join(directory, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
    expect(wrangler).not.toHaveProperty("main");
  });

  it("escapes display names in markup without changing configuration data", async () => {
    const directory = await target();
    const displayName = '<Arc & "Boat">';
    await renderVueTemplate({
      targetDirectory: directory,
      repository: "safe.example",
      siteId: "safe-example",
      displayName,
      accountId: "account-123",
      domain: "safe.example",
      aliases: [],
      withBackend: false,
    });

    const html = await readFile(join(directory, "index.html"), "utf8");
    const vue = await readFile(join(directory, "src/App.vue"), "utf8");
    const site = JSON.parse(await readFile(join(directory, "site.config.json"), "utf8")) as { displayName: string };
    expect(html).toContain("&lt;Arc &amp; &quot;Boat&quot;&gt;");
    expect(vue).toContain("&lt;Arc &amp; &quot;Boat&quot;&gt;");
    expect(site.displayName).toBe(displayName);
  });
});
