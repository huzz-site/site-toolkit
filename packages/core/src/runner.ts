import { spawn } from "node:child_process";

import { SiteError } from "./errors.js";

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly input?: string;
  readonly interactive?: boolean;
  readonly allowFailure?: boolean;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult>;
}

export class ProcessRunner implements CommandRunner {
  async run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const interactive = options.interactive ?? false;
      const environment = Object.fromEntries(
        Object.entries({ ...process.env, ...options.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: environment,
        shell: false,
        stdio: interactive ? "inherit" : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      if (!interactive) {
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        if (options.input !== undefined) {
          child.stdin?.end(options.input);
        }
      }

      child.once("error", (error) => {
        reject(
          new SiteError(
            error.message.includes("ENOENT") ? "DEPENDENCY_MISSING" : "COMMAND_FAILED",
            `Failed to start ${command}`,
            { command, cwd: options.cwd },
            { cause: error },
          ),
        );
      });

      child.once("close", (code) => {
        const result: CommandResult = {
          command,
          args: [...args],
          cwd: options.cwd,
          exitCode: code ?? 1,
          stdout,
          stderr,
        };
        if (result.exitCode !== 0 && !(options.allowFailure ?? false)) {
          reject(
            new SiteError("COMMAND_FAILED", `${command} exited with code ${result.exitCode}`, {
              command,
              args,
              cwd: options.cwd,
              stderr: stderr.trim().slice(-4000),
            }),
          );
          return;
        }
        resolve(result);
      });
    });
  }
}

export async function commandAvailable(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<boolean> {
  try {
    const result = await runner.run(command, args, { cwd, allowFailure: true });
    return result.exitCode === 0;
  } catch (error) {
    if (error instanceof SiteError && error.code === "DEPENDENCY_MISSING") return false;
    throw error;
  }
}

export function parseJsonOutput<T>(result: CommandResult, description: string): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new SiteError(
      "COMMAND_FAILED",
      `${description} did not return valid JSON`,
      { command: result.command, stdout: result.stdout.slice(0, 1000) },
      { cause: error },
    );
  }
}
