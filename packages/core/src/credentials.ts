import { CREDENTIAL_SERVICE } from "./constants.js";
import { SiteError } from "./errors.js";
import type { CommandRunner } from "./runner.js";

function credentialAccount(accountId: string): string {
  return `cloudflare-api-token:${accountId}`;
}

export async function saveCloudflareToken(
  runner: CommandRunner,
  accountId: string,
  token: string,
  cwd: string,
  interactive: boolean,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new SiteError(
      "DEPENDENCY_MISSING",
      "Secure token persistence currently requires macOS Keychain; use SITE_CLOUDFLARE_API_TOKEN on this platform",
    );
  }
  if (!interactive) {
    throw new SiteError(
      "USER_INPUT_REQUIRED",
      "Secure macOS Keychain storage requires an interactive terminal; run site init without --non-interactive",
    );
  }
  await runner.run(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s",
      CREDENTIAL_SERVICE,
      "-a",
      credentialAccount(accountId),
      "-w",
    ],
    { cwd, interactive: true },
  );
  const storedToken = await readCloudflareToken(runner, accountId, cwd);
  if (storedToken !== token) {
    throw new SiteError(
      "AUTH_CLOUDFLARE_MISSING",
      "The Cloudflare API Token entered for macOS Keychain did not match the validated token; run site init again",
    );
  }
}

export async function readCloudflareToken(
  runner: CommandRunner,
  accountId: string,
  cwd: string,
): Promise<string | undefined> {
  const fromEnvironment = process.env.SITE_CLOUDFLARE_API_TOKEN;
  if (fromEnvironment) return fromEnvironment;
  if (process.platform !== "darwin") return undefined;
  const result = await runner.run(
    "security",
    [
      "find-generic-password",
      "-s",
      CREDENTIAL_SERVICE,
      "-a",
      credentialAccount(accountId),
      "-w",
    ],
    { cwd, allowFailure: true },
  );
  const value = result.stdout.trim();
  return result.exitCode === 0 && value.length > 0 ? value : undefined;
}
