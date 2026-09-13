#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SiteError,
  SiteToolkitService,
  failure,
  normalizeError,
  success,
} from "@huzz-site/site-core";
import { Command, InvalidArgumentError, Option } from "commander";

import { chooseAccount } from "./prompts.js";

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

program
  .name("site")
  .description("Create, deploy, inspect, and roll back huzz-site websites")
  .version("0.1.0")
  .option("--json", "write a versioned JSON result to stdout", false)
  .option("--non-interactive", "never prompt for user input", false)
  .option("--cwd <directory>", "working directory", process.cwd())
  .showHelpAfterError();

program
  .command("init")
  .description("initialize the workspace, GitHub, and the default Cloudflare Account")
  .option("--workspace <directory>", "workspace directory")
  .option("--account-id <account-id>", "Cloudflare Account ID")
  .action(async (options: { workspace?: string; accountId?: string }) => {
    activeCommand = "init";
    const globals = globalOptions();
    const result = await service().init({
      workspace: resolve(options.workspace ?? globals.cwd),
      nonInteractive: globals.nonInteractive,
      ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
      ...(globals.nonInteractive ? {} : { chooseAccount }),
    });
    printResult("init", result);
  });

program
  .command("doctor")
  .description("inspect dependencies, authentication, permissions, and workspace state")
  .action(async () => {
    activeCommand = "doctor";
    const result = await service().doctor();
    printResult("doctor", result);
    if (!result.ready) process.exitCode = 1;
  });

program
  .command("create")
  .description("create a Vue website, GitHub repository, and first deployment")
  .argument("<repository>", "repository name")
  .requiredOption("--display-name <name>", "site display name")
  .option("--domain <domain>", "optional primary custom domain")
  .option("--alias <domain>", "additional custom domain; repeatable", collect, [])
  .option("--with-backend", "include the lightweight Worker API")
  .option("--no-backend", "create an assets-only Worker")
  .addOption(new Option("--visibility <visibility>", "GitHub repository visibility").default("private").argParser(visibility))
  .action(
    async (
      repository: string,
      options: {
        displayName: string;
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
      const result = await service().create({
        repository,
        displayName: options.displayName,
        ...(options.domain === undefined ? {} : { domain: options.domain }),
        aliases: options.alias,
        withBackend: options.withBackend === true || options.backend,
        visibility: options.visibility,
      });
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

program.parseAsync(process.argv).catch((error: unknown) => {
  const normalized = normalizeError(error);
  if (program.opts<Partial<GlobalOptions>>().json) {
    process.stdout.write(`${JSON.stringify(failure(activeCommand, normalized))}\n`);
  } else {
    process.stderr.write(`${normalized.code}: ${normalized.message}\n`);
    if (Object.keys(normalized.details).length > 0) {
      process.stderr.write(`${JSON.stringify(normalized.details, null, 2)}\n`);
    }
  }
  process.exitCode = normalized.exitCode;
});
