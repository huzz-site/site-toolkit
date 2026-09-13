import { describe, expect, it } from "vitest";

import { readCloudflareToken, saveCloudflareToken } from "../src/credentials.js";
import { SiteError } from "../src/errors.js";
import type { CommandResult, CommandRunner, RunOptions } from "../src/runner.js";

class KeychainRunner implements CommandRunner {
  storedToken: string | undefined;
  readonly calls: Array<{ command: string; args: readonly string[]; options: RunOptions }> = [];

  constructor(private readonly enteredToken: string) {}

  async run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    if (args[0] === "add-generic-password") this.storedToken = this.enteredToken;
    const isRead = args[0] === "find-generic-password";
    return {
      command,
      args,
      cwd: options.cwd,
      exitCode: isRead && this.storedToken === undefined ? 44 : 0,
      stdout: isRead && this.storedToken !== undefined ? `${this.storedToken}\n` : "",
      stderr: "",
    };
  }
}

describe("Cloudflare Token persistence", () => {
  it("uses an interactive Keychain prompt and verifies the stored token", async () => {
    const runner = new KeychainRunner("validated-token");

    await saveCloudflareToken(runner, "account-123", "validated-token", "/tmp", true);

    expect(await readCloudflareToken(runner, "account-123", "/tmp")).toBe("validated-token");
    const write = runner.calls.find(({ args }) => args[0] === "add-generic-password");
    expect(write?.options).toMatchObject({ interactive: true });
    expect(write?.options.input).toBeUndefined();
    expect(write?.args).not.toContain("validated-token");
  });

  it("rejects a mismatched value instead of reporting false success", async () => {
    const runner = new KeychainRunner("wrong-value");

    await expect(
      saveCloudflareToken(runner, "account-123", "validated-token", "/tmp", true),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "AUTH_CLOUDFLARE_MISSING" });
  });

  it("does not attempt insecure non-interactive persistence", async () => {
    const runner = new KeychainRunner("validated-token");

    await expect(
      saveCloudflareToken(runner, "account-123", "validated-token", "/tmp", false),
    ).rejects.toMatchObject<Partial<SiteError>>({ code: "USER_INPUT_REQUIRED" });
    expect(runner.calls).toHaveLength(0);
  });
});
