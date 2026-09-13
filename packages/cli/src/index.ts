#!/usr/bin/env node

import { resolve } from "node:path";
import { stdin, stderr } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  CLOUDFLARE_ACCOUNT_TOKEN_URL,
  SiteError,
  SiteToolkitService,
  cloudflareCredentialGuidance,
  failure,
  normalizeAccountId,
  normalizeError,
  success,
} from "@huzz-site/site-core";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import open from "open";

interface GlobalOptions {
  readonly json: boolean;
  readonly nonInteractive: boolean;
  readonly cwd: string;
}

const toolkitRoot = fileURLToPath(new URL("../../../", import.meta.url));
const program = new Command();
let activeCommand = "site";

function globalOptions(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

function service(): SiteToolkitService {
  const options = globalOptions();
  return new SiteToolkitService({
    cwd: resolve(options.cwd),
    toolkitRoot,
    log: (message) => process.stderr.write(`[site] ${message}\n`),
  });
}

function printResult(command: string, result: unknown, site?: string): void {
  const output = success(command, result, site === undefined ? {} : { site });
  process.stdout.write(`${JSON.stringify(output, null, globalOptions().json ? 0 : 2)}\n`);
}

function collect(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function visibility(value: string): "private" | "public" {
  if (value === "private" || value === "public") return value;
  throw new InvalidArgumentError("visibility must be private or public");
}

async function readHiddenValue(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new SiteError("USER_INPUT_REQUIRED", "A terminal is required for hidden Token input");
  }
  stderr.write(prompt);
  const hiddenOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const readline = createInterface({ input: stdin, output: hiddenOutput, terminal: true });
  try {
    return (await readline.question("")).trim();
  } finally {
    readline.close();
    stderr.write("\n");
  }
}

function requiresCloudflareLogin(error: unknown): error is SiteError {
  return error instanceof SiteError && [
    "AUTH_CLOUDFLARE_MISSING",
    "CF_ACCOUNT_NOT_FOUND",
    "CF_CI_SECRET_MISSING",
  ].includes(error.code);
}

async function interactiveCloudflareLogin(
  siteService: SiteToolkitService,
  accountIdInput: string,
): Promise<Record<string, unknown>> {
  const accountId = normalizeAccountId(accountIdInput);
  const guidance = cloudflareCredentialGuidance(accountId);
  if (globalOptions().nonInteractive) {
    throw new SiteError(
      "USER_INPUT_REQUIRED",
      "Cloudflare authentication requires an interactive terminal",
      { credentialGuidance: guidance },
    );
  }
  if (!stdin.isTTY) {
    throw new SiteError(
      "USER_INPUT_REQUIRED",
      "Cloudflare authentication requires an interactive terminal",
      { credentialGuidance: guidance },
    );
  }

  stderr.write(`[site] Opening Cloudflare Account API Tokens: ${CLOUDFLARE_ACCOUNT_TOKEN_URL}\n`);
  stderr.write(`[site] Select Account ${accountId} and use the 'Edit Cloudflare Workers' template\n`);
  try {
    await open(CLOUDFLARE_ACCOUNT_TOKEN_URL);
  } catch {
    stderr.write("[site] The browser could not be opened automatically; open the URL above manually\n");
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const token = await readHiddenValue("Cloudflare API Token (input hidden): ");
    try {
      return await siteService.saveCloudflareCredential(accountId, token);
    } catch (error) {
      if (!requiresCloudflareLogin(error) || attempt === 3) throw error;
      stderr.write(`[site] ${error.message}; check the Account and paste a replacement Token\n`);
    }
  }
  throw new SiteError("AUTH_CLOUDFLARE_MISSING", "Cloudflare authentication failed", {
    credentialGuidance: guidance,
  });
}

function printCredentialGuidance(details: Readonly<Record<string, unknown>>): boolean {
  const guidance = details.credentialGuidance;
  if (typeof guidance !== "object" || guidance === null) return false;
  const nextActions = (guidance as { nextActions?: unknown }).nextActions;
  if (!Array.isArray(nextActions) || !nextActions.every((action) => typeof action === "string")) return false;
  process.stderr.write("Next steps:\n");
  nextActions.forEach((action, index) => process.stderr.write(`  ${index + 1}. ${action}\n`));
  return true;
}

program
  .name("site")
  .description("Create, deploy, inspect, and roll back huzz-site websites")
  .version("1.1.2")
  .option("--json", "write a versioned JSON result to stdout", false)
  .option("--non-interactive", "never prompt for user input", false)
  .option("--cwd <directory>", "working directory", process.cwd())
  .showHelpAfterError()
  .exitOverride();

program
  .command("auth")
  .description("manage reusable Cloudflare Account credentials")
  .addCommand(
    new Command("login")
      .description("authenticate one Cloudflare Account and save its Token securely")
      .requiredOption("--account-id <account-id>", "Cloudflare Account ID")
      .action(async (options: { accountId: string }) => {
        activeCommand = "auth login";
        const result = await interactiveCloudflareLogin(service(), options.accountId);
        printResult("auth login", result);
      }),
  )
  .addCommand(
    new Command("forget")
      .description("remove one locally saved Cloudflare Account Token")
      .requiredOption("--account-id <account-id>", "Cloudflare Account ID")
      .action(async (options: { accountId: string }) => {
        activeCommand = "auth forget";
        printResult("auth forget", await service().forgetCloudflareCredential(options.accountId));
      }),
  );

program
  .command("doctor")
  .description("inspect dependencies, authentication, permissions, and an optional Cloudflare Account")
  .option("--account-id <account-id>", "Cloudflare Account ID to verify")
  .action(async (options: { accountId?: string }) => {
    activeCommand = "doctor";
    const siteService = service();
    let result = await siteService.doctor({
      ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    });
    const credentialStoreUnavailable = result.checks.some(
      (check) => check.code === "CREDENTIAL_STORE_UNAVAILABLE",
    );
    if (
      !globalOptions().nonInteractive
      && options.accountId !== undefined
      && result.credentialGuidance !== undefined
      && !credentialStoreUnavailable
    ) {
      await interactiveCloudflareLogin(siteService, options.accountId);
      result = await siteService.doctor({ accountId: options.accountId });
    }
    printResult("doctor", result);
    if (!result.ready) process.exitCode = 1;
  });

program
  .command("create")
  .description("create a Vue website, GitHub repository, and first deployment")
  .argument("<repository>", "repository name")
  .requiredOption("--display-name <name>", "site display name")
  .requiredOption("--account-id <account-id>", "Cloudflare Account ID")
  .option("--domain <domain>", "optional primary custom domain")
  .option("--alias <domain>", "additional custom domain; repeatable", collect, [])
  .option("--with-backend", "include the lightweight Worker API")
  .option("--no-backend", "create an assets-only Worker")
  .addOption(new Option("--visibility <visibility>", "GitHub repository visibility").makeOptionMandatory().argParser(visibility))
  .action(
    async (
      repository: string,
      options: {
        displayName: string;
        accountId: string;
        domain?: string;
        alias: readonly string[];
        backend: boolean;
        withBackend?: boolean;
        visibility: "private" | "public";
      },
    ) => {
      activeCommand = "create";
      if (options.withBackend === true && options.backend === false) {
        throw new SiteError("VALIDATION_ERROR", "--with-backend and --no-backend cannot be used together");
      }
      if (globalOptions().nonInteractive && options.withBackend !== true && options.backend !== false) {
        throw new SiteError("VALIDATION_ERROR", "Non-interactive create requires --with-backend or --no-backend");
      }
      if (options.domain === undefined && options.alias.length > 0) {
        throw new SiteError("VALIDATION_ERROR", "--alias requires --domain");
      }
      const siteService = service();
      const createOptions = {
        repository,
        displayName: options.displayName,
        accountId: options.accountId,
        ...(options.domain === undefined ? {} : { domain: options.domain }),
        aliases: options.alias,
        withBackend: options.withBackend === true || options.backend,
        visibility: options.visibility,
      } as const;
      let result: Record<string, unknown>;
      try {
        result = await siteService.create(createOptions);
      } catch (error) {
        if (globalOptions().nonInteractive || !requiresCloudflareLogin(error)) throw error;
        await interactiveCloudflareLogin(siteService, options.accountId);
        result = await siteService.create(createOptions);
      }
      printResult("create", result, repository);
    },
  );

program
  .command("check")
  .description("type-check, test, build, and dry-run the current site")
  .action(async () => {
    activeCommand = "check";
    const result = await service().check();
    printResult("check", result, result.site);
  });

program
  .command("dev")
  .description("start the current site's local development server")
  .action(async () => {
    activeCommand = "dev";
    if (globalOptions().nonInteractive) {
      throw new SiteError("USER_INPUT_REQUIRED", "site dev is an interactive command");
    }
    await service().dev();
  });

program
  .command("deploy")
  .description("deploy the current site and run production health checks")
  .option("--dry-run", "run every check without uploading", false)
  .action(async (options: { dryRun: boolean }) => {
    activeCommand = "deploy";
    const result = await service().deploy(undefined, options.dryRun);
    printResult("deploy", result, result.site);
  });

program
  .command("status")
  .description("show GitHub and Cloudflare state for the current site")
  .action(async () => {
    activeCommand = "status";
    const result = await service().status();
    printResult("status", result, typeof result.id === "string" ? result.id : undefined);
  });

program
  .command("versions")
  .description("list Cloudflare Worker versions for the current site")
  .action(async () => {
    activeCommand = "versions";
    printResult("versions", await service().versions());
  });

program
  .command("rollback")
  .description("roll back the current site to a previous Worker Version")
  .option("--previous", "roll back to the preceding deployed version", false)
  .option("--to <version-id>", "roll back to an exact Worker Version ID")
  .action(async (options: { previous: boolean; to?: string }) => {
    activeCommand = "rollback";
    if (options.previous === (options.to !== undefined)) {
      throw new SiteError("VALIDATION_ERROR", "Specify exactly one of --previous or --to <version-id>");
    }
    const target = options.to === undefined ? { previous: true as const } : { versionId: options.to };
    printResult("rollback", await service().rollback(target));
  });

const requestedCommand = process.argv.slice(2).find((argument) =>
  ["auth", "doctor", "create", "check", "dev", "deploy", "status", "versions", "rollback"].includes(argument),
);
if (requestedCommand !== undefined) activeCommand = requestedCommand;

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
    return;
  }
  const candidate = error instanceof CommanderError
    ? new SiteError("VALIDATION_ERROR", error.message)
    : error;
  const normalized = normalizeError(candidate);
  if (program.opts<Partial<GlobalOptions>>().json) {
    process.stdout.write(`${JSON.stringify(failure(activeCommand, normalized))}\n`);
  } else {
    process.stderr.write(`${normalized.code}: ${normalized.message}\n`);
    const printedGuidance = printCredentialGuidance(normalized.details);
    if (!printedGuidance && Object.keys(normalized.details).length > 0) {
      process.stderr.write(`${JSON.stringify(normalized.details, null, 2)}\n`);
    }
  }
  process.exitCode = normalized.exitCode;
});
