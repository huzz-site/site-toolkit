import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderVueTemplate } from "@huzz-site/site-templates";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SiteError } from "../src/errors.js";
import type { CredentialStore } from "../src/credential-store.js";
import type { CommandResult, CommandRunner, RunOptions } from "../src/runner.js";
import { SiteToolkitService, type ServiceOptions } from "../src/service.js";

type Handler = (command: string, args: readonly string[], options: RunOptions) => CommandResult | Promise<CommandResult>;

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options: RunOptions }> = [];

  constructor(private readonly handler: Handler) {}

  async run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    return this.handler(command, args, options);
  }
}

class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();

  constructor(entries: Readonly<Record<string, string>> = {}) {
    Object.entries(entries).forEach(([accountId, token]) => this.values.set(accountId, token));
  }

  async get(accountId: string): Promise<string | undefined> {
    return this.values.get(accountId);
  }

  async set(accountId: string, token: string): Promise<void> {
    this.values.set(accountId, token);
  }

  async delete(accountId: string): Promise<boolean> {
    return this.values.delete(accountId);
  }
}

function toolkit(options: ServiceOptions): SiteToolkitService {
  return new SiteToolkitService({ credentialStore: new MemoryCredentialStore(), ...options });
}

function result(command: string, args: readonly string[], cwd: string, stdout = "", exitCode = 0): CommandResult {
  return { command, args, cwd, stdout, stderr: "", exitCode };
}

const directories: string[] = [];
const ACCOUNT_ID = "11111111111111111111111111111111";
const OTHER_ACCOUNT_ID = "22222222222222222222222222222222";

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
    accountId: ACCOUNT_ID,
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

    const diagnosis = await toolkit({ cwd: root, toolkitRoot: root, runner }).doctor();
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

    const diagnosis = await toolkit({ cwd: root, toolkitRoot: root, runner }).doctor();
    expect(diagnosis.checks).toContainEqual(
      expect.objectContaining({ name: "github:organization", code: "AUTH_GITHUB_SCOPE_INSUFFICIENT" }),
    );
  });

  it("reports an inaccessible explicit Cloudflare Account", async () => {
    const root = await target();
    const runner = new FakeRunner((command, args, options) => {
      if (command === "pnpm" && args.includes("whoami")) {
        return result(
          command,
          args,
          options.cwd,
          `{"loggedIn":true,"accounts":[{"id":"${ACCOUNT_ID}","name":"Visible"}]}`,
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

    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    const diagnosis = await toolkit({ cwd: root, toolkitRoot: root, runner }).doctor({
      accountId: OTHER_ACCOUNT_ID,
    });

    expect(diagnosis.ready).toBe(false);
    expect(diagnosis.checks).toContainEqual(
      expect.objectContaining({ name: "cloudflare:account", code: "CF_ACCOUNT_NOT_FOUND" }),
    );
    expect(diagnosis.credentialGuidance).toMatchObject({
      accountId: OTHER_ACCOUNT_ID,
      template: "Edit Cloudflare Workers",
      environmentVariable: "CLOUDFLARE_API_TOKEN",
    });
    expect(runner.calls.some(({ args }) => args.includes("login"))).toBe(false);
  });

  it("prefers the credential stored for the requested Cloudflare Account", async () => {
    const root = await target();
    const credentials = new MemoryCredentialStore({ [ACCOUNT_ID]: "stored-token" });
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "different-environment-token");
    const runner = new FakeRunner((command, args, options) => {
      if (command === "pnpm" && args.includes("whoami")) {
        expect(options.env?.CLOUDFLARE_API_TOKEN).toBe("stored-token");
        return result(
          command,
          args,
          options.cwd,
          `{"loggedIn":true,"accounts":[{"id":"${ACCOUNT_ID}","name":"Stored Account"}]}`,
        );
      }
      if (command === "gh" && args[0] === "api" && args[1] === "orgs/huzz-site") {
        return result(command, args, options.cwd, '{"members_can_create_repositories":true}');
      }
      if (command === "gh" && args[0] === "api" && args[1] === "user/memberships/orgs/huzz-site") {
        return result(command, args, options.cwd, '{"role":"member","state":"active"}');
      }
      if (command === "pnpm" && args.includes("--version")) {
        return result(command, args, options.cwd, "4.131.1");
      }
      return result(command, args, options.cwd, "ok");
    });

    const diagnosis = await toolkit({
      cwd: root,
      toolkitRoot: root,
      runner,
      credentialStore: credentials,
    }).doctor({ accountId: ACCOUNT_ID });

    expect(diagnosis.ready).toBe(true);
    expect(diagnosis.credentialSource).toBe("system-credential-store");
  });

  it("validates and saves a Cloudflare Token without exposing it in the result", async () => {
    const root = await target();
    const credentials = new MemoryCredentialStore();
    const runner = new FakeRunner((command, args, options) => {
      if (command === "pnpm" && args.includes("whoami")) {
        expect(options.env?.CLOUDFLARE_API_TOKEN).toBe("new-secret-token");
        return result(
          command,
          args,
          options.cwd,
          `{"loggedIn":true,"accounts":[{"id":"${ACCOUNT_ID}","name":"Saved Account"}]}`,
        );
      }
      return result(command, args, options.cwd, "ok");
    });
    const service = toolkit({ cwd: root, toolkitRoot: root, runner, credentialStore: credentials });

    const saved = await service.saveCloudflareCredential(ACCOUNT_ID, "new-secret-token");

    expect(credentials.values.get(ACCOUNT_ID)).toBe("new-secret-token");
    expect(saved).toMatchObject({
      account: { id: ACCOUNT_ID, name: "Saved Account" },
      credentialSource: "system-credential-store",
    });
    expect(JSON.stringify(saved)).not.toContain("new-secret-token");

    const forgotten = await service.forgetCloudflareCredential(ACCOUNT_ID);
    expect(forgotten).toMatchObject({ accountId: ACCOUNT_ID, deleted: true });
    expect(credentials.values.has(ACCOUNT_ID)).toBe(false);
  });

  it("stops create before filesystem or remote writes when the Account is inaccessible", async () => {
    const workspace = await target();
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    const runner = new FakeRunner((command, args, options) => {
      if (command === "pnpm" && args.includes("whoami")) {
        return result(
          command,
          args,
          options.cwd,
          `{"loggedIn":true,"accounts":[{"id":"${ACCOUNT_ID}","name":"Visible"}]}`,
        );
      }
      if (command === "pnpm" && args.includes("--version")) {
        return result(command, args, options.cwd, "4.131.1");
      }
      if (command === "gh" && args[0] === "auth") return result(command, args, options.cwd, "ok");
      if (command === "gh" && args[0] === "api" && args[1] === "orgs/huzz-site") {
        return result(command, args, options.cwd, '{"members_can_create_repositories":true}');
      }
      if (command === "gh" && args[0] === "api" && args[1] === "user/memberships/orgs/huzz-site") {
        return result(command, args, options.cwd, '{"role":"member","state":"active"}');
      }
      return result(command, args, options.cwd, "ok");
    });

    await expect(
      toolkit({ cwd: workspace, toolkitRoot: workspace, runner }).create({
        repository: "blocked-site",
        displayName: "Blocked",
        accountId: OTHER_ACCOUNT_ID,
        aliases: [],
        withBackend: false,
        visibility: "private",
      }),
    ).rejects.toMatchObject<Partial<SiteError>>({
      code: "CF_ACCOUNT_NOT_FOUND",
      details: {
        credentialGuidance: expect.objectContaining({
          accountId: OTHER_ACCOUNT_ID,
          tokenCreationUrl: "https://dash.cloudflare.com/?to=/:account/api-tokens",
        }),
      },
    });

    expect(await (await import("node:fs/promises")).readdir(workspace)).toEqual([]);
    expect(runner.calls.some(({ command, args }) => command === "gh" && args[0] === "repo" && args[1] === "create")).toBe(false);
    expect(runner.calls.some(({ command, args }) => command === "git" && args[0] === "init")).toBe(false);
  });

  it("rejects a conflicting target directory before creating anything", async () => {
    const workspace = await target();
    const siteRoot = join(workspace, "taken");
    await mkdir(siteRoot);
    await writeFile(join(siteRoot, "unrelated.txt"), "mine");
    const runner = new FakeRunner((command, args, options) => result(command, args, options.cwd));

    await expect(
      toolkit({ cwd: workspace, toolkitRoot: workspace, runner }).create({
        repository: "taken",
        displayName: "Taken",
        accountId: ACCOUNT_ID,
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
      toolkit({ cwd: workspace, toolkitRoot: workspace, runner }).create({
        repository: "demo",
        displayName: "Demo",
        accountId: ACCOUNT_ID,
        aliases: ["www.demo.example"],
        withBackend: false,
        visibility: "private",
        skipRemote: true,
      }),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "VALIDATION_ERROR" });
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects retrying an existing site with a different Cloudflare Account", async () => {
    const workspace = await target();
    const siteRoot = join(workspace, "demo.example");
    await renderSite(siteRoot);
    const runner = new FakeRunner((command, args, options) => result(command, args, options.cwd));

    await expect(
      toolkit({ cwd: workspace, toolkitRoot: workspace, runner }).create({
        repository: "demo.example",
        displayName: "Demo",
        accountId: OTHER_ACCOUNT_ID,
        domain: "demo.example",
        aliases: [],
        withBackend: true,
        visibility: "private",
        skipRemote: true,
      }),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "CF_ACCOUNT_MISMATCH" });
  });

  it("resolves the workers.dev URL for a site without a custom domain", async () => {
    const root = await target();
    await renderVueTemplate({
      targetDirectory: root,
      repository: "demo",
      siteId: "demo",
      displayName: "Demo",
      accountId: ACCOUNT_ID,
      aliases: [],
      withBackend: true,
      compatibilityDate: "2026-09-12",
    });
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    const runner = new FakeRunner((command, args, options) => {
      let stdout = "{}";
      if (args.includes("deployments")) {
        stdout = '{"versions":[{"version_id":"current-version","percentage":100}]}';
      } else if (args.includes("versions")) {
        stdout = '[{"id":"old-version","number":1},{"id":"current-version","number":2}]';
      }
      return result(command, args, options.cwd, stdout);
    });
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => new Response(
      JSON.stringify({ success: true, result: { subdomain: "huzz" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const status = await toolkit({ cwd: root, toolkitRoot: root, runner, fetcher }).status();

    expect(status.urls).toEqual([
      "https://demo.huzz.workers.dev",
      "https://demo.huzz.workers.dev/api/health",
    ]);
    expect(status.version).toMatchObject({ id: "current-version", number: 2 });
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`,
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
      toolkit({ cwd: root, toolkitRoot: root, runner }).check(),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "CHECK_FAILED", details: { step: "build" } });
  });

  it("classifies upload failures as DEPLOY_FAILED", async () => {
    const root = await target();
    await renderSite(root);
    const runner = new FakeRunner((command, args, options) => {
      if (command === "git" && args[0] === "status") {
        return result(command, args, options.cwd, "");
      }
      if (command === "pnpm" && args.slice(-1)[0] === "deploy" && !args.includes("--dry-run")) {
        throw new SiteError("COMMAND_FAILED", "upload broke");
      }
      return result(command, args, options.cwd, "{}");
    });
    await expect(
      toolkit({ cwd: root, toolkitRoot: root, runner }).deploy(),
    ).rejects.toMatchObject<Partial<SiteError>>({
      code: "DEPLOY_FAILED",
      details: {
        cause: expect.objectContaining({ code: "COMMAND_FAILED", message: "upload broke" }),
      },
    });
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
      toolkit({ cwd: root, toolkitRoot: root, runner }).rollback({ previous: true }),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "ROLLBACK_FAILED" });
    expect(runner.calls.some(({ args }) => args.includes("rollback") && args.includes("--yes"))).toBe(true);
  });
});
