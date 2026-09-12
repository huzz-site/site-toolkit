import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { SiteError, type Account } from "@huzz-site/site-core";

export async function chooseAccount(accounts: readonly Account[]): Promise<Account> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new SiteError("USER_INPUT_REQUIRED", "Cloudflare Account selection requires a TTY");
  }
  stdout.write("Available Cloudflare Accounts:\n");
  accounts.forEach((account, index) => {
    stdout.write(`  ${index + 1}. ${account.name} (${account.id})\n`);
  });
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question("Select an account number: ");
    const index = Number.parseInt(answer, 10) - 1;
    const account = accounts[index];
    if (!account) throw new SiteError("VALIDATION_ERROR", "Invalid Account selection", { answer });
    return account;
  } finally {
    readline.close();
  }
}

export async function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    let value = "";
    for await (const chunk of stdin) value += String(chunk);
    const trimmed = value.trim();
    if (!trimmed) throw new SiteError("USER_INPUT_REQUIRED", "A secret value is required");
    return trimmed;
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const previousRaw = stdin.isRaw;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();

    const finish = (error?: Error): void => {
      stdin.off("data", onData);
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else if (value.length === 0) reject(new SiteError("USER_INPUT_REQUIRED", "A secret value is required"));
      else resolve(value);
    };

    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\u0003") {
          finish(new SiteError("USER_INPUT_REQUIRED", "Secret input was cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    stdin.on("data", onData);
  });
}
