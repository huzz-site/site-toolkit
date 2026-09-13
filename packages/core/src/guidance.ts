export const CLOUDFLARE_ACCOUNT_TOKEN_URL = "https://dash.cloudflare.com/?to=/:account/api-tokens";
export const CLOUDFLARE_TOKEN_DOCUMENTATION_URL =
  "https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/#api-token";

export interface CredentialGuidance {
  readonly accountId: string;
  readonly authCommand: string;
  readonly tokenCreationUrl: string;
  readonly documentationUrl: string;
  readonly template: "Edit Cloudflare Workers";
  readonly environmentVariable: "CLOUDFLARE_API_TOKEN";
  readonly nextActions: readonly string[];
}

export function cloudflareCredentialGuidance(accountId: string): CredentialGuidance {
  const authCommand = `site auth login --account-id ${accountId}`;
  return {
    accountId,
    authCommand,
    tokenCreationUrl: CLOUDFLARE_ACCOUNT_TOKEN_URL,
    documentationUrl: CLOUDFLARE_TOKEN_DOCUMENTATION_URL,
    template: "Edit Cloudflare Workers",
    environmentVariable: "CLOUDFLARE_API_TOKEN",
    nextActions: [
      `Run interactively: ${authCommand}`,
      `The command opens ${CLOUDFLARE_ACCOUNT_TOKEN_URL}; select Cloudflare Account ${accountId} and create a token from the 'Edit Cloudflare Workers' template`,
      "Paste the token only into the hidden CLI prompt; it will be saved in the operating system credential store for this Account",
      "For CI, headless systems, or an unavailable system credential store, inject the Token as CLOUDFLARE_API_TOKEN instead",
      `Verify with: site --non-interactive --json doctor --account-id ${accountId}`,
      "Run the same create command again",
    ],
  };
}
