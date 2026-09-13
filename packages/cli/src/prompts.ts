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
