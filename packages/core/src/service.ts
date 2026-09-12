import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { renderVueTemplate } from "@huzz-site/site-templates";

import {
  GITHUB_ORGANIZATION,
  MINIMUM_NODE_MAJOR,
  MINIMUM_WRANGLER_MAJOR,
  SCHEMA_VERSION,
  SITE_CONFIG_FILE,
  WORKSPACE_CONFIG_FILE,
} from "./constants.js";
import {
  loadSiteConfig,
  loadWorkspaceConfig,
  loadWranglerConfig,
  writeWorkspaceConfig,
  type WorkspaceConfig,
} from "./config.js";
import { readCloudflareToken, saveCloudflareToken } from "./credentials.js";
import { SiteError } from "./errors.js";
import {
  ProcessRunner,
  commandAvailable,
  parseJsonOutput,
  type CommandResult,
  type CommandRunner,
} from "./runner.js";
import { directoryIsEmpty, exists, findSiteRoot, findWorkspaceRoot } from "./workspace.js";

export interface Account {
  readonly id: string;
  readonly name: string;
}

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly detail: string;
}

export interface DoctorResult {
  readonly ready: boolean;
  readonly checks: readonly DoctorCheck[];
  readonly workspace?: string;
  readonly account?: Account;
}

export interface InitOptions {
  readonly workspace: string;
  readonly nonInteractive: boolean;
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly chooseAccount?: (accounts: readonly Account[]) => Promise<Account>;
  readonly readApiToken?: () => Promise<string>;
}

export interface CreateOptions {
  readonly repository: string;
  readonly displayName: string;
  readonly domain: string;
  readonly aliases: readonly string[];
  readonly withBackend: boolean;
  readonly visibility: "private" | "public";
  readonly skipRemote?: boolean;
}

export interface StepResult {
  readonly name: string;
  readonly status: "completed" | "unchanged";
  readonly durationMs: number;
}

export interface CheckResult {
  readonly site: string;
  readonly root: string;
  readonly worker: string;
  readonly steps: readonly StepResult[];
}

export interface DeployResult extends CheckResult {
  readonly deployment: unknown;
  readonly version: unknown;
  readonly urls: readonly string[];
  readonly health: readonly HealthResult[];
}

export interface HealthResult {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
}

interface CloudflareWhoami {
  readonly loggedIn?: boolean;
  readonly accounts?: readonly unknown[];
}

interface WorkflowRun {
  readonly databaseId?: number;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly url?: string;
  readonly headSha?: string;
}

interface GitHubOrganizationPolicy {
  readonly members_can_create_repositories?: boolean;
  readonly members_can_create_public_repositories?: boolean;
  readonly members_can_create_private_repositories?: boolean;
}

interface GitHubMembership {
  readonly role?: string;
  readonly state?: string;
}

export interface ServiceOptions {
  readonly cwd?: string;
  readonly toolkitRoot: string;
  readonly runner?: CommandRunner;
  readonly log?: (message: string) => void;
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

function accountFromUnknown(value: unknown): Account | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record.id ?? record.accountId ?? record.account_id;
  const name = record.name ?? record.accountName ?? record.account_name;
  if (typeof id !== "string" || id.length === 0) return undefined;
  return { id, name: typeof name === "string" && name.length > 0 ? name : id };
}

function accountsFromWhoami(value: CloudflareWhoami): readonly Account[] {
  if (!Array.isArray(value.accounts)) return [];
  return value.accounts.map(accountFromUnknown).filter((account): account is Account => account !== undefined);
}

function normalizeRepositoryName(repository: string): string {
  const value = repository.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(value)) {
    throw new SiteError("VALIDATION_ERROR", "Invalid GitHub repository name", { repository });
  }
  return value;
}

function normalizeDomain(domain: string): string {
  const value = domain.trim().toLowerCase().replace(/\.$/, "");
  if (
    value.length > 253 ||
    !value.includes(".") ||
    !value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new SiteError("VALIDATION_ERROR", "Invalid domain name", { domain });
  }
  return value;
}

function normalizeDisplayName(displayName: string): string {
  const value = displayName.trim();
  if (value.length === 0 || value.length > 120) {
    throw new SiteError("VALIDATION_ERROR", "Display name must contain 1 to 120 characters");
  }
  return value;
}

export function toWorkerName(repository: string): string {
  const value = repository.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const trimmed = value.slice(0, 63).replace(/-+$/g, "");
  if (!/^[a-z][a-z0-9-]*$/.test(trimmed)) {
    return `site-${trimmed || "worker"}`.slice(0, 63);
  }
  return trimmed;
}

export class SiteToolkitService {
  readonly cwd: string;
  readonly toolkitRoot: string;
  readonly runner: CommandRunner;
  readonly log: (message: string) => void;

  constructor(options: ServiceOptions) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.toolkitRoot = resolve(options.toolkitRoot);
    this.runner = options.runner ?? new ProcessRunner();
    this.log = options.log ?? (() => undefined);
  }

  private async runWrangler(
    args: readonly string[],
    cwd: string,
    options: { readonly interactive?: boolean; readonly input?: string; readonly env?: Readonly<Record<string, string>>; readonly allowFailure?: boolean } = {},
  ): Promise<CommandResult> {
    const storedEnvironment = args.includes("--version")
      ? undefined
      : await this.resolveCloudflareEnvironment(cwd);
    const environment = { ...storedEnvironment, ...options.env };
    return this.runner.run("pnpm", ["exec", "wrangler", ...args], {
      cwd,
      ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
      ...(options.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
    });
  }

  private async resolveCloudflareEnvironment(cwd: string): Promise<Readonly<Record<string, string>> | undefined> {
    const directToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.SITE_CLOUDFLARE_API_TOKEN;
    const directAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (directToken) {
      return {
        CLOUDFLARE_API_TOKEN: directToken,
        ...(directAccount === undefined ? {} : { CLOUDFLARE_ACCOUNT_ID: directAccount }),
      };
    }

    let accountId: string | undefined;
    try {
      const siteRoot = await findSiteRoot(cwd);
      accountId = (await loadWranglerConfig(siteRoot)).account_id;
    } catch (error) {
      if (!(error instanceof SiteError) || error.code !== "SITE_NOT_FOUND") throw error;
    }
    if (!accountId) {
      try {
        const workspace = await findWorkspaceRoot(cwd);
        accountId = (await loadWorkspaceConfig(workspace)).cloudflare.accountId;
      } catch (error) {
        if (!(error instanceof SiteError) || error.code !== "WORKSPACE_NOT_INITIALIZED") throw error;
      }
    }
    if (!accountId) return undefined;
    const token = await readCloudflareToken(this.runner, accountId, cwd);
    return token
      ? { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId }
      : undefined;
  }

  private async runStep(
    name: string,
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<StepResult> {
    this.log(name);
    const start = performance.now();
    await this.runner.run(command, args, { cwd });
    return { name, status: "completed", durationMs: elapsed(start) };
  }

  private async wranglerStep(name: string, args: readonly string[], cwd: string): Promise<StepResult> {
    this.log(name);
    const start = performance.now();
    await this.runWrangler(args, cwd);
    return { name, status: "completed", durationMs: elapsed(start) };
  }

  private async readWhoami(
    cwd: string,
    allowFailure = false,
    env?: Readonly<Record<string, string>>,
  ): Promise<CloudflareWhoami> {
    const result = await this.runWrangler(["whoami", "--json"], cwd, {
      allowFailure,
      ...(env === undefined ? {} : { env }),
    });
    if (result.exitCode !== 0) return { loggedIn: false };
    return parseJsonOutput<CloudflareWhoami>(result, "wrangler whoami");
  }

  private async githubRepositoryAccess(cwd: string): Promise<{ organizationAccessible: boolean; canCreate: boolean }> {
    const [organizationResult, membershipResult] = await Promise.all([
      this.runner.run("gh", ["api", `orgs/${GITHUB_ORGANIZATION}`], { cwd, allowFailure: true }),
      this.runner.run("gh", ["api", `user/memberships/orgs/${GITHUB_ORGANIZATION}`], {
        cwd,
        allowFailure: true,
      }),
    ]);
    const organizationAccessible = organizationResult.exitCode === 0;
    if (!organizationAccessible || membershipResult.exitCode !== 0) {
      return { organizationAccessible, canCreate: false };
    }
    const organization = parseJsonOutput<GitHubOrganizationPolicy>(organizationResult, "GitHub organization");
    const membership = parseJsonOutput<GitHubMembership>(membershipResult, "GitHub organization membership");
    if (membership.state !== "active") return { organizationAccessible, canCreate: false };
    if (membership.role === "admin") return { organizationAccessible, canCreate: true };
    const canCreate = organization.members_can_create_repositories === true
      || organization.members_can_create_public_repositories === true
      || organization.members_can_create_private_repositories === true;
    return { organizationAccessible, canCreate };
  }

  async doctor(start = this.cwd): Promise<DoctorResult> {
    const checks: DoctorCheck[] = [];
    const dependencies: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      ["git", "git", ["--version"]],
      ["pnpm", "pnpm", ["--version"]],
      ["gh", "gh", ["--version"]],
    ];

    for (const [name, command, args] of dependencies) {
      const ok = await commandAvailable(this.runner, command, args, this.toolkitRoot);
      checks.push({
        name: `dependency:${name}`,
        ok,
        ...(ok ? {} : { code: "DEPENDENCY_MISSING" }),
        detail: ok ? "available" : `${command} is not available`,
      });
    }

    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    checks.push({
      name: "dependency:node",
      ok: nodeMajor >= MINIMUM_NODE_MAJOR,
      ...(nodeMajor >= MINIMUM_NODE_MAJOR ? {} : { code: "DEPENDENCY_MISSING" }),
      detail: process.versions.node,
    });

    const wrangler = await this.runWrangler(["--version"], this.toolkitRoot, { allowFailure: true });
    const wranglerMajor = Number.parseInt(wrangler.stdout.match(/\d+/)?.[0] ?? "0", 10);
    checks.push({
      name: "dependency:wrangler",
      ok: wrangler.exitCode === 0 && wranglerMajor >= MINIMUM_WRANGLER_MAJOR,
      ...(wrangler.exitCode === 0 && wranglerMajor >= MINIMUM_WRANGLER_MAJOR
        ? {}
        : { code: "DEPENDENCY_MISSING" }),
      detail: wrangler.stdout.trim() || wrangler.stderr.trim() || "unavailable",
    });

    const githubAuth = await this.runner.run("gh", ["auth", "status"], {
      cwd: this.toolkitRoot,
      allowFailure: true,
    });
    checks.push({
      name: "auth:github",
      ok: githubAuth.exitCode === 0,
      ...(githubAuth.exitCode === 0 ? {} : { code: "AUTH_GITHUB_MISSING" }),
      detail: githubAuth.exitCode === 0 ? "authenticated" : "not authenticated",
    });

    if (githubAuth.exitCode === 0) {
      const access = await this.githubRepositoryAccess(this.toolkitRoot);
      checks.push({
        name: "github:organization",
        ok: access.organizationAccessible,
        ...(access.organizationAccessible ? {} : { code: "AUTH_GITHUB_SCOPE_INSUFFICIENT" }),
        detail: access.organizationAccessible ? GITHUB_ORGANIZATION : "organization is not accessible",
      });
      checks.push({
        name: "github:repository-create",
        ok: access.canCreate,
        ...(access.canCreate ? {} : { code: "AUTH_GITHUB_SCOPE_INSUFFICIENT" }),
        detail: access.canCreate ? "allowed" : "repository creation is not allowed",
      });
    }

    const whoami = await this.readWhoami(this.toolkitRoot, true);
    checks.push({
      name: "auth:cloudflare",
      ok: whoami.loggedIn === true,
      ...(whoami.loggedIn === true ? {} : { code: "AUTH_CLOUDFLARE_MISSING" }),
      detail: whoami.loggedIn === true ? "authenticated" : "not authenticated",
    });

    let workspace: string | undefined;
    let account: Account | undefined;
    try {
      workspace = await findWorkspaceRoot(start);
      const config = await loadWorkspaceConfig(workspace);
      account = { id: config.cloudflare.accountId, name: config.cloudflare.accountName };
      const accountVisible = accountsFromWhoami(whoami).some((candidate) => candidate.id === account?.id);
      checks.push({
        name: "workspace",
        ok: true,
        detail: workspace,
      });
      checks.push({
        name: "cloudflare:account",
        ok: whoami.loggedIn === true && accountVisible,
        ...(whoami.loggedIn === true && accountVisible ? {} : { code: "CF_ACCOUNT_NOT_FOUND" }),
        detail: `${account.name} (${account.id})`,
      });
      const ciToken = await readCloudflareToken(this.runner, account.id, this.toolkitRoot);
      checks.push({
        name: "credential:cloudflare-ci-token",
        ok: ciToken !== undefined,
        ...(ciToken === undefined ? { code: "CF_CI_SECRET_MISSING" } : {}),
        detail: ciToken === undefined ? "not found in environment or macOS Keychain" : "available",
      });
    } catch (error) {
      const siteError = error instanceof SiteError ? error : undefined;
      checks.push({
        name: "workspace",
        ok: false,
        code: siteError?.code ?? "WORKSPACE_INVALID",
        detail: siteError?.message ?? String(error),
      });
    }

    return {
      ready: checks.every((check) => check.ok),
      checks,
      ...(workspace === undefined ? {} : { workspace }),
      ...(account === undefined ? {} : { account }),
    };
  }

  async init(options: InitOptions): Promise<{ workspace: string; account: Account; changed: readonly string[] }> {
    const workspace = resolve(options.workspace);
    await mkdir(workspace, { recursive: true });

    for (const [command, args] of [
      ["git", ["--version"]],
      ["pnpm", ["--version"]],
      ["gh", ["--version"]],
    ] as const) {
      if (!(await commandAvailable(this.runner, command, args, this.toolkitRoot))) {
        throw new SiteError("DEPENDENCY_MISSING", `${command} is required`, { command });
      }
    }

    let githubAuth = await this.runner.run("gh", ["auth", "status"], {
      cwd: workspace,
      allowFailure: true,
    });
    if (githubAuth.exitCode !== 0) {
      if (options.nonInteractive) {
        throw new SiteError("AUTH_GITHUB_MISSING", "GitHub authentication is required");
      }
      await this.runner.run("gh", ["auth", "login", "--web", "--git-protocol", "https"], {
        cwd: workspace,
        interactive: true,
      });
      githubAuth = await this.runner.run("gh", ["auth", "status"], { cwd: workspace });
    }
    if (!(await this.githubRepositoryAccess(workspace)).canCreate) {
      throw new SiteError(
        "AUTH_GITHUB_SCOPE_INSUFFICIENT",
        `Current GitHub identity cannot create repositories in ${GITHUB_ORGANIZATION}`,
      );
    }

    let existing: WorkspaceConfig | undefined;
    if (await exists(join(workspace, WORKSPACE_CONFIG_FILE))) {
      existing = await loadWorkspaceConfig(workspace);
    }
    const candidateAccountId = options.accountId ?? existing?.cloudflare.accountId;
    const storedToken = candidateAccountId === undefined
      ? undefined
      : await readCloudflareToken(this.runner, candidateAccountId, workspace);
    const token = options.apiToken
      ?? process.env.SITE_CLOUDFLARE_API_TOKEN
      ?? process.env.CLOUDFLARE_API_TOKEN
      ?? storedToken
      ?? (await options.readApiToken?.());
    if (!token) {
      throw new SiteError("USER_INPUT_REQUIRED", "A Cloudflare API Token is required");
    }
    let whoami: CloudflareWhoami;
    try {
      whoami = await this.readWhoami(this.toolkitRoot, false, {
        CLOUDFLARE_API_TOKEN: token,
        ...(candidateAccountId === undefined ? {} : { CLOUDFLARE_ACCOUNT_ID: candidateAccountId }),
      });
    } catch (error) {
      throw new SiteError("AUTH_CLOUDFLARE_MISSING", "Cloudflare API Token validation failed", {}, { cause: error });
    }

    const accounts = accountsFromWhoami(whoami);
    if (accounts.length === 0) {
      throw new SiteError("CF_ACCOUNT_NOT_FOUND", "No Cloudflare Account is available");
    }
    let account = options.accountId === undefined
      ? accounts.length === 1
        ? accounts[0]
        : undefined
      : accounts.find((candidate) => candidate.id === options.accountId);
    if (options.accountId !== undefined && !account) {
      throw new SiteError("CF_ACCOUNT_NOT_FOUND", "Requested Cloudflare Account is not accessible", {
        accountId: options.accountId,
      });
    }
    if (!account && options.chooseAccount) {
      account = await options.chooseAccount(accounts);
    }
    if (!account) {
      throw new SiteError("USER_INPUT_REQUIRED", "A Cloudflare Account must be selected", {
        accounts: accounts.map(({ id, name }) => ({ id, name })),
      });
    }

    const changed: string[] = [];
    const config: WorkspaceConfig = {
      schemaVersion: SCHEMA_VERSION,
      organization: GITHUB_ORGANIZATION,
      cloudflare: { accountId: account.id, accountName: account.name },
    };
    if (JSON.stringify(existing) !== JSON.stringify(config)) {
      await writeWorkspaceConfig(workspace, config);
      changed.push(WORKSPACE_CONFIG_FILE);
    }

    if (storedToken !== token) {
      await saveCloudflareToken(this.runner, account.id, token, workspace);
      changed.push("keychain:CLOUDFLARE_API_TOKEN");
    }

    return { workspace, account, changed };
  }

  private async assertSiteAccount(siteRoot: string): Promise<void> {
    const wrangler = await loadWranglerConfig(siteRoot);
    const environmentAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (environmentAccount && environmentAccount !== wrangler.account_id) {
      throw new SiteError("CF_ACCOUNT_MISMATCH", "Environment Account ID does not match wrangler.jsonc", {
        configured: wrangler.account_id,
        environment: environmentAccount,
      });
    }
    try {
      const workspace = await findWorkspaceRoot(siteRoot);
      const config = await loadWorkspaceConfig(workspace);
      if (config.cloudflare.accountId !== wrangler.account_id) {
        throw new SiteError("CF_ACCOUNT_MISMATCH", "Workspace Account ID does not match wrangler.jsonc", {
          configured: wrangler.account_id,
          workspace: config.cloudflare.accountId,
        });
      }
    } catch (error) {
      if (error instanceof SiteError && error.code === "WORKSPACE_NOT_INITIALIZED") return;
      throw error;
    }
  }

  async check(start = this.cwd): Promise<CheckResult> {
    const root = await findSiteRoot(start);
    const site = await loadSiteConfig(root);
    const wrangler = await loadWranglerConfig(root);
    await this.assertSiteAccount(root);
    const steps: StepResult[] = [];
    let currentStep = "configuration";
    try {
      currentStep = "worker-types";
      steps.push(await this.wranglerStep("Generate Worker types", ["types"], root));
      currentStep = "typecheck";
      steps.push(await this.runStep("Type check", "pnpm", ["typecheck"], root));
      currentStep = "tests";
      steps.push(await this.runStep("Run tests", "pnpm", ["test"], root));
      currentStep = "build";
      steps.push(await this.runStep("Build", site.build.command, site.build.args, root));
      currentStep = "wrangler-dry-run";
      steps.push(await this.wranglerStep("Wrangler dry run", ["deploy", "--dry-run"], root));
    } catch (error) {
      throw new SiteError("CHECK_FAILED", `Site check failed during ${currentStep}`, { step: currentStep }, { cause: error });
    }
    return { site: site.id, root, worker: wrangler.name, steps };
  }

  async dev(start = this.cwd): Promise<void> {
    const root = await findSiteRoot(start);
    await loadSiteConfig(root);
    await this.runner.run("pnpm", ["dev"], { cwd: root, interactive: true });
  }

  private async healthCheck(urls: readonly string[]): Promise<readonly HealthResult[]> {
    const results: HealthResult[] = [];
    for (const url of urls) {
      let lastStatus = 0;
      let ok = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
          lastStatus = response.status;
          ok = response.ok;
          if (ok) break;
        } catch {
          lastStatus = 0;
        }
        if (attempt < 11) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
      }
      results.push({ url, status: lastStatus, ok });
    }
    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) {
      throw new SiteError("HEALTHCHECK_FAILED", "One or more production health checks failed", { failed });
    }
    return results;
  }

  private async cloudflareStatus(root: string): Promise<{ deployment: unknown; version: unknown }> {
    const [deploymentResult, versionsResult] = await Promise.all([
      this.runWrangler(["deployments", "status", "--json"], root),
      this.runWrangler(["versions", "list", "--json"], root),
    ]);
    const deployment = parseJsonOutput<unknown>(deploymentResult, "wrangler deployments status");
    const versions = parseJsonOutput<unknown>(versionsResult, "wrangler versions list");
    const version = Array.isArray(versions) ? versions[0] ?? null : versions;
    return { deployment, version };
  }

  private async waitForWorkflow(repository: string, headSha: string, cwd: string): Promise<WorkflowRun> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listResult = await this.runner.run(
        "gh",
        [
          "run",
          "list",
          "--repo",
          repository,
          "--commit",
          headSha,
          "--limit",
          "10",
          "--json",
          "databaseId,status,conclusion,url,headSha",
        ],
        { cwd },
      );
      const runs = parseJsonOutput<readonly WorkflowRun[]>(listResult, "gh run list");
      const run = runs.find((candidate) => candidate.headSha === headSha && candidate.databaseId !== undefined);
      if (run?.databaseId !== undefined) {
        if (run.status === "completed" && run.conclusion !== "success") {
          await this.runner.run(
            "gh",
            ["run", "rerun", String(run.databaseId), "--repo", repository],
            { cwd },
          );
        }
        await this.runner.run(
          "gh",
          ["run", "watch", String(run.databaseId), "--repo", repository, "--exit-status", "--interval", "5"],
          { cwd },
        );
        const viewResult = await this.runner.run(
          "gh",
          ["run", "view", String(run.databaseId), "--repo", repository, "--json", "databaseId,status,conclusion,url,headSha"],
          { cwd },
        );
        return parseJsonOutput<WorkflowRun>(viewResult, "gh run view");
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    }
    throw new SiteError("DEPLOY_FAILED", "GitHub Actions did not start for the pushed commit", {
      repository,
      headSha,
    });
  }

  async deploy(start = this.cwd, dryRun = false): Promise<DeployResult | CheckResult> {
    const root = await findSiteRoot(start);
    const gitStatus = await this.runner.run("git", ["status", "--porcelain"], { cwd: root });
    if (gitStatus.stdout.trim().length > 0) {
      throw new SiteError("DEPLOY_FAILED", "Production deploy requires a clean Git worktree", {
        files: gitStatus.stdout.trim().split("\n"),
      });
    }
    const checked = await this.check(root);
    if (dryRun) return checked;
    try {
      await this.runWrangler(["deploy"], root);
    } catch (error) {
      throw new SiteError("DEPLOY_FAILED", "Cloudflare deployment failed", {}, { cause: error });
    }
    const site = await loadSiteConfig(root);
    const status = await this.cloudflareStatus(root);
    const health = await this.healthCheck(site.healthChecks);
    return {
      ...checked,
      ...status,
      urls: site.healthChecks,
      health,
    };
  }

  async status(start = this.cwd): Promise<Record<string, unknown>> {
    const root = await findSiteRoot(start);
    const site = await loadSiteConfig(root);
    const wrangler = await loadWranglerConfig(root);
    await this.assertSiteAccount(root);
    const remote = await this.runner.run("git", ["config", "--get", "remote.origin.url"], {
      cwd: root,
      allowFailure: true,
    });
    const actions = await this.runner.run(
      "gh",
      [
        "run",
        "list",
        "--repo",
        `${GITHUB_ORGANIZATION}/${basename(root)}`,
        "--limit",
        "1",
        "--json",
        "databaseId,status,conclusion,url,headSha,workflowName",
      ],
      { cwd: root, allowFailure: true },
    );
    const cloudflare = await this.cloudflareStatus(root);
    return {
      id: site.id,
      displayName: site.displayName,
      root,
      repository: remote.stdout.trim() || null,
      worker: wrangler.name,
      accountId: wrangler.account_id,
      actions: actions.exitCode === 0 ? parseJsonOutput<unknown>(actions, "gh run list") : null,
      ...cloudflare,
      urls: site.healthChecks,
    };
  }

  async versions(start = this.cwd): Promise<unknown> {
    const root = await findSiteRoot(start);
    await this.assertSiteAccount(root);
    const result = await this.runWrangler(["versions", "list", "--json"], root);
    return parseJsonOutput<unknown>(result, "wrangler versions list");
  }

  async rollback(
    target: { readonly previous: true } | { readonly versionId: string },
    start = this.cwd,
  ): Promise<Record<string, unknown>> {
    const root = await findSiteRoot(start);
    const site = await loadSiteConfig(root);
    await this.assertSiteAccount(root);
    const before = await this.cloudflareStatus(root);
    const args = "versionId" in target
      ? ["rollback", target.versionId, "--message", `site rollback to ${target.versionId}`]
      : ["rollback", "--message", "site rollback to previous version"];
    try {
      await this.runWrangler(args, root);
    } catch (error) {
      throw new SiteError("ROLLBACK_FAILED", "Cloudflare rollback failed", {}, { cause: error });
    }
    const after = await this.cloudflareStatus(root);
    const health = await this.healthCheck(site.healthChecks);
    return { before, after, health };
  }

  async create(options: CreateOptions): Promise<Record<string, unknown>> {
    const repository = normalizeRepositoryName(options.repository);
    const displayName = normalizeDisplayName(options.displayName);
    const domain = normalizeDomain(options.domain);
    const aliases = [...new Set(options.aliases.map(normalizeDomain))].filter((alias) => alias !== domain);
    const workspace = await findWorkspaceRoot(this.cwd);
    const workspaceConfig = await loadWorkspaceConfig(workspace);
    const target = join(workspace, repository);
    const siteId = toWorkerName(repository);
    const fullRepository = `${GITHUB_ORGANIZATION}/${repository}`;

    if (!options.skipRemote) {
      const diagnosis = await this.doctor(workspace);
      if (!diagnosis.ready) {
        throw new SiteError("WORKSPACE_INVALID", "Workspace is not ready; run site doctor for details", {
          checks: diagnosis.checks.filter((check) => !check.ok),
        });
      }
      const remote = await this.runner.run("gh", ["repo", "view", fullRepository, "--json", "name"], {
        cwd: workspace,
        allowFailure: true,
      });
      if (remote.exitCode === 0) {
        if (!(await exists(join(target, ".git")))) {
          throw new SiteError("RESOURCE_CONFLICT", "GitHub repository already exists but no matching local Git repository exists", {
            repository: fullRepository,
            target,
          });
        }
        const origin = await this.runner.run("git", ["remote", "get-url", "origin"], {
          cwd: target,
          allowFailure: true,
        });
        const expected = `github.com/${fullRepository}`.toLowerCase();
        if (origin.exitCode !== 0 || !origin.stdout.trim().toLowerCase().includes(expected)) {
          throw new SiteError("RESOURCE_CONFLICT", "GitHub repository already exists but is not linked to this site", {
            repository: fullRepository,
            target,
          });
        }
      }
    }

    if (!(await directoryIsEmpty(target))) {
      if (!(await exists(join(target, SITE_CONFIG_FILE)))) {
        throw new SiteError("RESOURCE_CONFLICT", "Target directory is not empty", { target });
      }
      const existing = await loadSiteConfig(target);
      if (existing.id !== siteId) {
        throw new SiteError("RESOURCE_CONFLICT", "Existing site has a different site ID", {
          target,
          expected: siteId,
          actual: existing.id,
        });
      }
    } else {
      await renderVueTemplate({
        targetDirectory: target,
        repository,
        siteId,
        displayName,
        accountId: workspaceConfig.cloudflare.accountId,
        domain,
        aliases,
        withBackend: options.withBackend,
      });
    }

    await this.runner.run("pnpm", ["install"], { cwd: target });
    const checks = await this.check(target);

    if (!(await exists(join(target, ".git")))) {
      await this.runner.run("git", ["init", "-b", "main"], { cwd: target });
    }
    await this.runner.run("git", ["add", "--all"], { cwd: target });
    const staged = await this.runner.run("git", ["diff", "--cached", "--quiet"], {
      cwd: target,
      allowFailure: true,
    });
    if (staged.exitCode === 1) {
      await this.runner.run("git", ["commit", "-m", `chore: initialize ${displayName}`], { cwd: target });
    }

    if (options.skipRemote) {
      return {
        repository: `${GITHUB_ORGANIZATION}/${repository}`,
        root: target,
        worker: siteId,
        checks,
        remote: "skipped",
      };
    }

    const remoteExists = await this.runner.run("gh", ["repo", "view", fullRepository, "--json", "name"], {
      cwd: target,
      allowFailure: true,
    });
    if (remoteExists.exitCode !== 0) {
      await this.runner.run(
        "gh",
        [
          "repo",
          "create",
          fullRepository,
          options.visibility === "private" ? "--private" : "--public",
          "--source",
          target,
          "--remote",
          "origin",
        ],
        { cwd: target },
      );
    } else {
      const origin = await this.runner.run("git", ["remote", "get-url", "origin"], {
        cwd: target,
        allowFailure: true,
      });
      if (origin.exitCode !== 0) {
        await this.runner.run(
          "git",
          ["remote", "add", "origin", `https://github.com/${fullRepository}.git`],
          { cwd: target },
        );
      }
    }

    const cloudflareToken = await readCloudflareToken(
      this.runner,
      workspaceConfig.cloudflare.accountId,
      workspace,
    );
    if (!cloudflareToken) {
      throw new SiteError(
        "CF_CI_SECRET_MISSING",
        "Cloudflare CI token is unavailable; run site init or set SITE_CLOUDFLARE_API_TOKEN",
      );
    }
    await this.runner.run(
      "gh",
      ["secret", "set", "CLOUDFLARE_API_TOKEN", "--repo", fullRepository],
      { cwd: target, input: `${cloudflareToken}\n` },
    );
    await this.runner.run(
      "gh",
      [
        "variable",
        "set",
        "CLOUDFLARE_ACCOUNT_ID",
        "--repo",
        fullRepository,
        "--body",
        workspaceConfig.cloudflare.accountId,
      ],
      { cwd: target },
    );
    await this.runner.run("git", ["push", "--set-upstream", "origin", "main"], { cwd: target });

    const head = await this.runner.run("git", ["rev-parse", "HEAD"], { cwd: target });
    const workflow = await this.waitForWorkflow(fullRepository, head.stdout.trim(), target);
    const cloudflare = await this.cloudflareStatus(target);
    const site = await loadSiteConfig(target);
    const health = await this.healthCheck(site.healthChecks);

    return {
      repository: fullRepository,
      root: target,
      worker: siteId,
      checks,
      workflow,
      ...cloudflare,
      urls: site.healthChecks,
      health,
    };
  }
}
