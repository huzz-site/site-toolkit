import { basename, join, resolve } from "node:path";

import { renderVueTemplate } from "@huzz-site/site-templates";

import {
  GITHUB_ORGANIZATION,
  MINIMUM_NODE_MAJOR,
  MINIMUM_WRANGLER_MAJOR,
  SITE_CONFIG_FILE,
  WRANGLER_CONFIG_FILE,
} from "./constants.js";
import {
  loadSiteConfig,
  loadWranglerConfig,
  type SiteConfig,
  type WranglerConfig,
} from "./config.js";
import {
  CREDENTIAL_SERVICE,
  SystemCredentialStore,
  type CredentialStore,
} from "./credential-store.js";
import { readCloudflareToken } from "./credentials.js";
import { SiteError } from "./errors.js";
import { cloudflareCredentialGuidance, type CredentialGuidance } from "./guidance.js";
import {
  ProcessRunner,
  commandAvailable,
  parseJsonOutput,
  type CommandResult,
  type CommandRunner,
} from "./runner.js";
import { directoryIsEmpty, exists, findSiteRoot } from "./workspace.js";

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
  readonly workspace: string;
  readonly account?: Account;
  readonly accounts: readonly Account[];
  readonly credentialGuidance?: CredentialGuidance;
  readonly credentialSource?: "environment" | "system-credential-store";
}

export interface DoctorOptions {
  readonly start?: string;
  readonly accountId?: string;
}

export interface CreateOptions {
  readonly repository: string;
  readonly displayName: string;
  readonly accountId: string;
  readonly domain?: string;
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

interface WorkerDeployment {
  readonly versions?: readonly { readonly version_id?: string; readonly percentage?: number }[];
}

interface WorkerVersion {
  readonly id?: string;
  readonly [key: string]: unknown;
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
  readonly fetcher?: typeof globalThis.fetch;
  readonly credentialStore?: CredentialStore;
  readonly log?: (message: string) => void;
}

interface ResolvedCredential {
  readonly token: string;
  readonly source: "environment" | "system-credential-store";
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

function causeDetails(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof SiteError) {
    return {
      cause: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }
  if (error instanceof Error) return { cause: { message: error.message } };
  return { cause: { message: String(error) } };
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

export function normalizeAccountId(accountId: string): string {
  const value = accountId.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(value)) {
    throw new SiteError("VALIDATION_ERROR", "Cloudflare Account ID must be 32 hexadecimal characters", {
      accountId,
    });
  }
  return value;
}

function remoteMatchesRepository(remote: string, repository: string): boolean {
  const value = remote.trim().toLowerCase().replace(/\.git$/, "");
  const expected = repository.toLowerCase();
  return value === `https://github.com/${expected}`
    || value === `git@github.com:${expected}`
    || value === `ssh://git@github.com/${expected}`;
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
  readonly fetcher: typeof globalThis.fetch;
  readonly credentialStore: CredentialStore;
  readonly log: (message: string) => void;
  private readonly credentialCache = new Map<string, string>();

  constructor(options: ServiceOptions) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.toolkitRoot = resolve(options.toolkitRoot);
    this.runner = options.runner ?? new ProcessRunner();
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.credentialStore = options.credentialStore ?? new SystemCredentialStore();
    this.log = options.log ?? (() => undefined);
  }

  private async runWrangler(
    args: readonly string[],
    cwd: string,
    options: { readonly interactive?: boolean; readonly input?: string; readonly env?: Readonly<Record<string, string | undefined>>; readonly allowFailure?: boolean; readonly accountId?: string } = {},
  ): Promise<CommandResult> {
    let accountId = options.accountId;
    if (accountId === undefined && !args.includes("--version") && await exists(join(cwd, WRANGLER_CONFIG_FILE))) {
      accountId = (await loadWranglerConfig(cwd)).account_id;
    }
    const explicitToken = options.env?.CLOUDFLARE_API_TOKEN;
    const storedEnvironment = args.includes("--version") || explicitToken !== undefined
      ? { CLOUDFLARE_ACCOUNT_ID: undefined }
      : await this.resolveCloudflareEnvironment(accountId);
    const environment = { ...storedEnvironment, ...options.env };
    return this.runner.run("pnpm", ["exec", "wrangler", ...args], {
      cwd,
      ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
      ...(options.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
    });
  }

  private async resolveCloudflareCredential(accountId?: string): Promise<ResolvedCredential | undefined> {
    const environmentToken = readCloudflareToken();
    const runningInCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
    if (environmentToken !== undefined && runningInCi) {
      return { token: environmentToken, source: "environment" };
    }
    let storeError: unknown;
    if (accountId !== undefined) {
      const cached = this.credentialCache.get(accountId);
      if (cached !== undefined) return { token: cached, source: "system-credential-store" };
      try {
        const stored = await this.credentialStore.get(accountId);
        if (stored !== undefined) {
          this.credentialCache.set(accountId, stored);
          return { token: stored, source: "system-credential-store" };
        }
      } catch (error) {
        storeError = error;
      }
    }
    if (environmentToken !== undefined) return { token: environmentToken, source: "environment" };
    if (storeError !== undefined) throw storeError;
    return undefined;
  }

  private async resolveCloudflareEnvironment(accountId?: string): Promise<Readonly<Record<string, string | undefined>>> {
    const credential = await this.resolveCloudflareCredential(accountId);
    return {
      ...(credential === undefined ? {} : { CLOUDFLARE_API_TOKEN: credential.token }),
      // A shell-level Account ID must never override a site's wrangler.jsonc.
      CLOUDFLARE_ACCOUNT_ID: undefined,
    };
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
    env?: Readonly<Record<string, string | undefined>>,
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

  async doctor(options: DoctorOptions = {}): Promise<DoctorResult> {
    const workspace = resolve(options.start ?? this.cwd);
    const accountId = options.accountId === undefined ? undefined : normalizeAccountId(options.accountId);
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

    let credential: ResolvedCredential | undefined;
    let credentialError: SiteError | undefined;
    try {
      credential = await this.resolveCloudflareCredential(accountId);
    } catch (error) {
      credentialError = error instanceof SiteError
        ? error
        : new SiteError("CREDENTIAL_STORE_UNAVAILABLE", "Cannot read the system credential store", {}, { cause: error });
    }
    checks.push({
      name: "credential:cloudflare-api-token",
      ok: credential !== undefined,
      ...(credential === undefined
        ? { code: credentialError?.code ?? "CF_CI_SECRET_MISSING" }
        : {}),
      detail: credential === undefined
        ? credentialError?.message ?? "not available for the requested Cloudflare Account"
        : `available from ${credential.source}`,
    });

    const whoami = credential === undefined
      ? { loggedIn: false }
      : await this.readWhoami(this.toolkitRoot, true, {
          CLOUDFLARE_API_TOKEN: credential.token,
          CLOUDFLARE_ACCOUNT_ID: undefined,
        });
    checks.push({
      name: "auth:cloudflare",
      ok: whoami.loggedIn === true,
      ...(whoami.loggedIn === true ? {} : { code: "AUTH_CLOUDFLARE_MISSING" }),
      detail: whoami.loggedIn === true ? "authenticated" : "not authenticated",
    });

    const accounts = accountsFromWhoami(whoami);
    let account: Account | undefined;
    if (accountId !== undefined) {
      account = accounts.find((candidate) => candidate.id === accountId);
      checks.push({
        name: "cloudflare:account",
        ok: account !== undefined,
        ...(account === undefined ? { code: "CF_ACCOUNT_NOT_FOUND" } : {}),
        detail: account === undefined ? `${accountId} is not accessible` : `${account.name} (${account.id})`,
      });
    }

    return {
      ready: checks.every((check) => check.ok),
      checks,
      workspace,
      ...(account === undefined ? {} : { account }),
      accounts,
      ...(credential === undefined ? {} : { credentialSource: credential.source }),
      ...(accountId !== undefined && (credential === undefined || whoami.loggedIn !== true || account === undefined)
        ? { credentialGuidance: cloudflareCredentialGuidance(accountId) }
        : {}),
    };
  }

  async saveCloudflareCredential(accountIdInput: string, tokenInput: string): Promise<Record<string, unknown>> {
    const accountId = normalizeAccountId(accountIdInput);
    const token = tokenInput.trim();
    if (token.length === 0) {
      throw new SiteError("VALIDATION_ERROR", "Cloudflare API Token cannot be empty");
    }

    const whoami = await this.readWhoami(this.toolkitRoot, true, {
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: undefined,
    });
    if (whoami.loggedIn !== true) {
      throw new SiteError("AUTH_CLOUDFLARE_MISSING", "Cloudflare rejected the API Token", {
        credentialGuidance: cloudflareCredentialGuidance(accountId),
      });
    }
    const account = accountsFromWhoami(whoami).find((candidate) => candidate.id === accountId);
    if (account === undefined) {
      throw new SiteError("CF_ACCOUNT_NOT_FOUND", "Cloudflare API Token cannot access the requested Account", {
        accountId,
        credentialGuidance: cloudflareCredentialGuidance(accountId),
      });
    }

    await this.credentialStore.set(accountId, token);
    this.credentialCache.set(accountId, token);
    return {
      account,
      credentialStore: CREDENTIAL_SERVICE,
      credentialSource: "system-credential-store",
    };
  }

  async forgetCloudflareCredential(accountIdInput: string): Promise<Record<string, unknown>> {
    const accountId = normalizeAccountId(accountIdInput);
    const deleted = await this.credentialStore.delete(accountId);
    this.credentialCache.delete(accountId);
    return {
      accountId,
      deleted,
      credentialStore: CREDENTIAL_SERVICE,
      note: "This only removes the local credential; revoke the Token in Cloudflare if required.",
    };
  }

  async check(start = this.cwd): Promise<CheckResult> {
    const root = await findSiteRoot(start);
    const site = await loadSiteConfig(root);
    const wrangler = await loadWranglerConfig(root);
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
          const response = await this.fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
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

  private async deploymentUrls(site: SiteConfig, wrangler: WranglerConfig): Promise<readonly string[]> {
    if (site.healthChecks.length > 0) return site.healthChecks;

    const credential = await this.resolveCloudflareCredential(wrangler.account_id);
    if (credential === undefined) {
      throw new SiteError(
        "AUTH_CLOUDFLARE_MISSING",
        "A Cloudflare API Token is required to resolve the workers.dev deployment URL",
        { credentialGuidance: cloudflareCredentialGuidance(wrangler.account_id) },
      );
    }

    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(wrangler.account_id)}/workers/subdomain`,
        {
          headers: { Authorization: `Bearer ${credential.token}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      throw new SiteError("COMMAND_FAILED", "Cannot resolve the Cloudflare workers.dev subdomain", {}, { cause: error });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new SiteError(
        "COMMAND_FAILED",
        "Cloudflare returned an invalid workers.dev subdomain response",
        { status: response.status },
        { cause: error },
      );
    }
    const result = typeof payload === "object" && payload !== null
      ? (payload as { success?: unknown; result?: unknown })
      : undefined;
    const subdomainResult = typeof result?.result === "object" && result.result !== null
      ? result.result as { subdomain?: unknown }
      : undefined;
    if (!response.ok || result?.success !== true || typeof subdomainResult?.subdomain !== "string" || subdomainResult.subdomain.length === 0) {
      throw new SiteError("COMMAND_FAILED", "Cloudflare did not return a workers.dev subdomain", {
        status: response.status,
        accountId: wrangler.account_id,
      });
    }

    const origin = `https://${wrangler.name}.${subdomainResult.subdomain}.workers.dev`;
    return wrangler.main === undefined ? [origin] : [origin, `${origin}/api/health`];
  }

  private async cloudflareStatus(root: string): Promise<{ deployment: unknown; version: unknown }> {
    const [deploymentResult, versionsResult] = await Promise.all([
      this.runWrangler(["deployments", "status", "--json"], root),
      this.runWrangler(["versions", "list", "--json"], root),
    ]);
    const deployment = parseJsonOutput<WorkerDeployment>(deploymentResult, "wrangler deployments status");
    const versions = parseJsonOutput<readonly WorkerVersion[] | WorkerVersion>(versionsResult, "wrangler versions list");
    const deployedVersionId = deployment.versions?.find((candidate) => (candidate.percentage ?? 0) > 0)?.version_id;
    const version = Array.isArray(versions)
      ? versions.find((candidate) => candidate.id === deployedVersionId) ?? versions.at(-1) ?? null
      : versions;
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
      throw new SiteError("DEPLOY_FAILED", "Cloudflare deployment failed", causeDetails(error), { cause: error });
    }
    const site = await loadSiteConfig(root);
    const wrangler = await loadWranglerConfig(root);
    const status = await this.cloudflareStatus(root);
    const urls = await this.deploymentUrls(site, wrangler);
    const health = await this.healthCheck(urls);
    return {
      ...checked,
      ...status,
      urls,
      health,
    };
  }

  async status(start = this.cwd): Promise<Record<string, unknown>> {
    const root = await findSiteRoot(start);
    const site = await loadSiteConfig(root);
    const wrangler = await loadWranglerConfig(root);
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
    const urls = await this.deploymentUrls(site, wrangler);
    return {
      id: site.id,
      displayName: site.displayName,
      root,
      repository: remote.stdout.trim() || null,
      worker: wrangler.name,
      accountId: wrangler.account_id,
      actions: actions.exitCode === 0 ? parseJsonOutput<unknown>(actions, "gh run list") : null,
      ...cloudflare,
      urls,
    };
  }

  async versions(start = this.cwd): Promise<unknown> {
    const root = await findSiteRoot(start);
    const result = await this.runWrangler(["versions", "list", "--json"], root);
    return parseJsonOutput<unknown>(result, "wrangler versions list");
  }

  async rollback(
    target: { readonly previous: true } | { readonly versionId: string },
    start = this.cwd,
  ): Promise<Record<string, unknown>> {
    const root = await findSiteRoot(start);
    const site = await loadSiteConfig(root);
    const wrangler = await loadWranglerConfig(root);
    const before = await this.cloudflareStatus(root);
    const args = "versionId" in target
      ? ["rollback", target.versionId, "--message", `site rollback to ${target.versionId}`, "--yes"]
      : ["rollback", "--message", "site rollback to previous version", "--yes"];
    try {
      await this.runWrangler(args, root);
    } catch (error) {
      throw new SiteError("ROLLBACK_FAILED", "Cloudflare rollback failed", causeDetails(error), { cause: error });
    }
    const after = await this.cloudflareStatus(root);
    const urls = await this.deploymentUrls(site, wrangler);
    const health = await this.healthCheck(urls);
    return { before, after, urls, health };
  }

  async create(options: CreateOptions): Promise<Record<string, unknown>> {
    const repository = normalizeRepositoryName(options.repository);
    const displayName = normalizeDisplayName(options.displayName);
    const accountId = normalizeAccountId(options.accountId);
    const domain = options.domain === undefined ? undefined : normalizeDomain(options.domain);
    if (domain === undefined && options.aliases.length > 0) {
      throw new SiteError("VALIDATION_ERROR", "Aliases require a primary custom domain");
    }
    const aliases = [...new Set(options.aliases.map(normalizeDomain))].filter((alias) => alias !== domain);
    const workspace = this.cwd;
    const target = join(workspace, repository);
    const siteId = toWorkerName(repository);
    const fullRepository = `${GITHUB_ORGANIZATION}/${repository}`;

    if (!options.skipRemote) {
      const diagnosis = await this.doctor({ start: workspace, accountId });
      if (!diagnosis.ready) {
        const failed = diagnosis.checks.filter((check) => !check.ok);
        const credentialGuidance = cloudflareCredentialGuidance(accountId);
        if (failed.some((check) => check.code === "CREDENTIAL_STORE_UNAVAILABLE")) {
          throw new SiteError("CREDENTIAL_STORE_UNAVAILABLE", "Cannot access the system credential store", {
            checks: failed,
            credentialGuidance,
          });
        }
        if (failed.some((check) => check.code === "AUTH_CLOUDFLARE_MISSING" || check.code === "CF_CI_SECRET_MISSING")) {
          throw new SiteError("AUTH_CLOUDFLARE_MISSING", "CLOUDFLARE_API_TOKEN is missing or invalid", {
            checks: failed,
            credentialGuidance,
          });
        }
        if (failed.some((check) => check.code === "CF_ACCOUNT_NOT_FOUND")) {
          throw new SiteError("CF_ACCOUNT_NOT_FOUND", "Cloudflare API Token cannot access the requested Account", {
            accountId,
            checks: failed,
            credentialGuidance,
          });
        }
        throw new SiteError("PREFLIGHT_FAILED", "Create preflight failed; run site doctor for details", { checks: failed });
      }
      await this.runner.run("gh", ["auth", "setup-git"], { cwd: workspace });
      const remote = await this.runner.run("gh", ["repo", "view", fullRepository, "--json", "name"], {
        cwd: workspace,
        allowFailure: true,
      });
      let linkedExistingSite = false;
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
        if (origin.exitCode !== 0 || !remoteMatchesRepository(origin.stdout, fullRepository)) {
          throw new SiteError("RESOURCE_CONFLICT", "GitHub repository already exists but is not linked to this site", {
            repository: fullRepository,
            target,
          });
        }
        linkedExistingSite = true;
      }
      const worker = await this.runWrangler(
        ["versions", "list", "--name", siteId, "--json"],
        this.toolkitRoot,
        { allowFailure: true, accountId },
      );
      if (worker.exitCode === 0 && !linkedExistingSite) {
        throw new SiteError("RESOURCE_CONFLICT", "Cloudflare Worker name is already in use", {
          worker: siteId,
          repository: fullRepository,
        });
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
      const existingWrangler = await loadWranglerConfig(target);
      if (existingWrangler.account_id !== accountId) {
        throw new SiteError("CF_ACCOUNT_MISMATCH", "Existing site belongs to a different Cloudflare Account", {
          configured: existingWrangler.account_id,
          requested: accountId,
        });
      }
    } else {
      await renderVueTemplate({
        targetDirectory: target,
        repository,
        siteId,
        displayName,
        accountId,
        ...(domain === undefined ? {} : { domain }),
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

    const credential = await this.resolveCloudflareCredential(accountId);
    if (credential === undefined) {
      throw new SiteError(
        "CF_CI_SECRET_MISSING",
        "Cloudflare CI token is unavailable",
        { credentialGuidance: cloudflareCredentialGuidance(accountId) },
      );
    }
    await this.runner.run(
      "gh",
      ["secret", "set", "CLOUDFLARE_API_TOKEN", "--repo", fullRepository],
      { cwd: target, input: `${credential.token}\n` },
    );
    await this.runner.run("git", ["push", "--set-upstream", "origin", "main"], { cwd: target });

    const head = await this.runner.run("git", ["rev-parse", "HEAD"], { cwd: target });
    const workflow = await this.waitForWorkflow(fullRepository, head.stdout.trim(), target);
    const cloudflare = await this.cloudflareStatus(target);
    const site = await loadSiteConfig(target);
    const wrangler = await loadWranglerConfig(target);
    const urls = await this.deploymentUrls(site, wrangler);

    return {
      repository: fullRepository,
      root: target,
      worker: siteId,
      checks,
      workflow,
      ...cloudflare,
      urls,
      health: {
        ok: true,
        source: "github-actions",
        workflowRunId: workflow.databaseId ?? null,
      },
    };
  }
}
