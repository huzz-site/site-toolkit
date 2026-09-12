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
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new SiteError(
      "DEPENDENCY_MISSING",
      "Secure token persistence currently requires macOS Keychain; use SITE_CLOUDFLARE_API_TOKEN on this platform",
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
    { cwd, input: `${token}\n` },
  );
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
