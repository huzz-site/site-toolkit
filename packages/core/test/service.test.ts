import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderVueTemplate } from "@huzz-site/site-templates";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeWorkspaceConfig } from "../src/config.js";
import { SiteError } from "../src/errors.js";
import type { CommandResult, CommandRunner, RunOptions } from "../src/runner.js";
import { SiteToolkitService } from "../src/service.js";

type Handler = (command: string, args: readonly string[], options: RunOptions) => CommandResult | Promise<CommandResult>;

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];

  constructor(private readonly handler: Handler) {}

  async run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args });
    return this.handler(command, args, options);
  }
}

function result(command: string, args: readonly string[], cwd: string, stdout = "", exitCode = 0): CommandResult {
  return { command, args, cwd, stdout, stderr: "", exitCode };
}

const directories: string[] = [];

async function target(prefix = "site-service-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function renderSite(root: string): Promise<void> {
  await renderVueTemplate({
    targetDirectory: root,
    repository: "demo.example",
    siteId: "demo-example",
    displayName: "Demo",
    accountId: "account-123",
    domain: "demo.example",
    aliases: [],
    withBackend: true,
    compatibilityDate: "2026-09-12",
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SiteToolkitService failure boundaries", () => {
  it("reports missing authentication without prompting", async () => {
    const root = await target();
    const runner = new FakeRunner((command, args, options) => {
      if (command === "pnpm" && args.includes("whoami")) {
        return result(command, args, options.cwd, '{"loggedIn":false}');
      }
      if (command === "gh" && args[0] === "auth") return result(command, args, options.cwd, "", 1);
      if (command === "pnpm" && args.includes("--version")) return result(command, args, options.cwd, "4.131.1");
      return result(command, args, options.cwd, "ok");
    });

    const diagnosis = await new SiteToolkitService({ cwd: root, toolkitRoot: root, runner }).doctor();
    expect(diagnosis.ready).toBe(false);
    expect(diagnosis.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "AUTH_GITHUB_MISSING" }),
        expect.objectContaining({ code: "AUTH_CLOUDFLARE_MISSING" }),
      ]),
    );
  });

  it("reports insufficient GitHub organization access", async () => {
    const root = await target();
    const runner = new FakeRunner((command, args, options) => {
      if (command === "gh" && args[0] === "auth") return result(command, args, options.cwd, "ok");
      if (command === "gh" && args[0] === "api") return result(command, args, options.cwd, "", 1);
      if (command === "pnpm" && args.includes("whoami")) return result(command, args, options.cwd, '{"loggedIn":false}');
      if (command === "pnpm" && args.includes("--version")) return result(command, args, options.cwd, "4.131.1");
      return result(command, args, options.cwd, "ok");
    });

    const diagnosis = await new SiteToolkitService({ cwd: root, toolkitRoot: root, runner }).doctor();
    expect(diagnosis.checks).toContainEqual(
      expect.objectContaining({ name: "github:organization", code: "AUTH_GITHUB_SCOPE_INSUFFICIENT" }),
    );
  });

  it("rejects an inaccessible explicit Cloudflare Account without OAuth fallback", async () => {
    const root = await target();
    const runner = new FakeRunner((command, args, options) => {
      if (command === "pnpm" && args.includes("whoami")) {
        return result(
          command,
          args,
          options.cwd,
          '{"loggedIn":true,"accounts":[{"id":"visible-account","name":"Visible"}]}',
        );
      }
      if (command === "gh" && args[0] === "api" && args[1] === "orgs/huzz-site") {
        return result(command, args, options.cwd, '{"members_can_create_repositories":true}');
      }
      if (command === "gh" && args[0] === "api" && args[1] === "user/memberships/orgs/huzz-site") {
        return result(command, args, options.cwd, '{"role":"member","state":"active"}');
      }
      return result(command, args, options.cwd, "ok");
    });

    await expect(
      new SiteToolkitService({ cwd: root, toolkitRoot: root, runner }).init({
        workspace: root,
        nonInteractive: true,
        accountId: "missing-account",
        apiToken: "test-token",
      }),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "CF_ACCOUNT_NOT_FOUND" });
    expect(runner.calls.some(({ args }) => args.includes("login"))).toBe(false);
  });

  it("rejects a conflicting target directory before creating anything", async () => {
    const workspace = await target();
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      organization: "huzz-site",
      cloudflare: { accountId: "account-123", accountName: "Default" },
    });
    const siteRoot = join(workspace, "taken");
    await mkdir(siteRoot);
    await writeFile(join(siteRoot, "unrelated.txt"), "mine");
    const runner = new FakeRunner((command, args, options) => result(command, args, options.cwd));

    await expect(
      new SiteToolkitService({ cwd: workspace, toolkitRoot: workspace, runner }).create({
        repository: "taken",
        displayName: "Taken",
        domain: "taken.example",
        aliases: [],
        withBackend: true,
        visibility: "private",
        skipRemote: true,
      }),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "RESOURCE_CONFLICT" });
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects aliases when no primary custom domain is configured", async () => {
    const workspace = await target();
    const runner = new FakeRunner((command, args, options) => result(command, args, options.cwd));

    await expect(
      new SiteToolkitService({ cwd: workspace, toolkitRoot: workspace, runner }).create({
        repository: "demo",
        displayName: "Demo",
        aliases: ["www.demo.example"],
        withBackend: false,
        visibility: "private",
        skipRemote: true,
      }),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "VALIDATION_ERROR" });
    expect(runner.calls).toHaveLength(0);
  });

  it("resolves the workers.dev URL for a site without a custom domain", async () => {
    const root = await target();
    await renderVueTemplate({
      targetDirectory: root,
      repository: "demo",
      siteId: "demo",
      displayName: "Demo",
      accountId: "account-123",
      aliases: [],
      withBackend: true,
      compatibilityDate: "2026-09-12",
    });
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    const runner = new FakeRunner((command, args, options) => {
      const stdout = args.includes("versions") ? "[]" : "{}";
      return result(command, args, options.cwd, stdout);
    });
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => new Response(
      JSON.stringify({ success: true, result: { subdomain: "huzz" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const status = await new SiteToolkitService({ cwd: root, toolkitRoot: root, runner, fetcher }).status();

    expect(status.urls).toEqual([
      "https://demo.huzz.workers.dev",
      "https://demo.huzz.workers.dev/api/health",
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-123/workers/subdomain",
      expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
    );
  });

  it("classifies build failures as CHECK_FAILED", async () => {
    const root = await target();
    await renderSite(root);
    const runner = new FakeRunner((command, args, options) => {
      if (command === "pnpm" && args[0] === "build") {
        throw new SiteError("COMMAND_FAILED", "build broke");
      }
      return result(command, args, options.cwd, args.includes("--version") ? "4.131.1" : "{}");
    });
    await expect(
      new SiteToolkitService({ cwd: root, toolkitRoot: root, runner }).check(),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "CHECK_FAILED", details: { step: "build" } });
  });

  it("classifies upload failures as DEPLOY_FAILED", async () => {
    const root = await target();
    await renderSite(root);
    const runner = new FakeRunner((command, args, options) => {
      if (command === "pnpm" && args.slice(-1)[0] === "deploy" && !args.includes("--dry-run")) {
        throw new SiteError("COMMAND_FAILED", "upload broke");
      }
      return result(command, args, options.cwd, "{}");
    });
    await expect(
      new SiteToolkitService({ cwd: root, toolkitRoot: root, runner }).deploy(),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "DEPLOY_FAILED" });
  });

  it("classifies rollback failures as ROLLBACK_FAILED", async () => {
    const root = await target();
    await renderSite(root);
    const runner = new FakeRunner((command, args, options) => {
      if (command === "pnpm" && args.includes("rollback")) {
        throw new SiteError("COMMAND_FAILED", "rollback broke");
      }
      const stdout = args.includes("versions") ? "[]" : "{}";
      return result(command, args, options.cwd, stdout);
    });
    await expect(
      new SiteToolkitService({ cwd: root, toolkitRoot: root, runner }).rollback({ previous: true }),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "ROLLBACK_FAILED" });
    expect(runner.calls.some(({ args }) => args.includes("rollback") && args.includes("--yes"))).toBe(true);
  });
});
