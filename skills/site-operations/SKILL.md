---
name: site-operations
description: Create websites in a huzz-site workspace, or validate, deploy, inspect, and roll back repositories managed by the Site Toolkit CLI. Existing sites must contain site.config.json; do not use for unrelated Cloudflare projects.
---

# Site Operations

Translate the user's explicit intent into one deterministic `site` CLI invocation. The CLI is the sole authority for GitHub and Cloudflare mutations.

## Invocation

Run `site` with both `--non-interactive` and `--json`. If the binary is not installed, run the repository entrypoint from the `site-toolkit` checkout:

```bash
pnpm --dir <site-toolkit> exec tsx --conditions=development packages/cli/src/index.ts --cwd <workspace-or-site> --non-interactive --json <command> [arguments]
```

Parse stdout as the versioned result object. Treat stderr as human-readable progress only.

## Map intent to commands

- Authenticate a Cloudflare Account: this is a user-only interactive step, `auth login --account-id <account-id>`; never invoke it in an AI run.
- Inspect readiness: `doctor [--account-id <account-id>]`
- Create and deploy a repository: `create <repository> --display-name <name> --account-id <account-id> [--domain <domain> [--alias <domain>]] <--with-backend|--no-backend> --visibility <private|public>`
- Validate without upload: `check` or `deploy --dry-run`
- Deploy the current committed site: `deploy`
- Inspect the current deployment: `status`
- List Worker versions: `versions`
- Roll back: `rollback --previous` or `rollback --to <version-id>`

For `create`, require the repository, display name, Cloudflare Account ID, backend choice, and visibility to be explicit. The primary domain is optional: omit it to deploy only to `workers.dev`; never invent one. `--alias` requires `--domain`. Never infer or reuse a Cloudflare Account from another site.

## Boundaries

- Do not call `gh`, `wrangler`, Cloudflare APIs, or GitHub APIs to perform a write that the CLI owns.
- Do not deploy or roll back unless the user explicitly requested that mutation. Creating a site includes its first deployment.
- Do not expose destructive deletion or implicit account-switching workflows.
- On authentication or credential errors, surface the CLI's `credentialGuidance.authCommand` and stop. Never invoke interactive `auth login`, request a Token in chat, or handle the Token yourself; the user runs the CLI flow, which saves it in the operating system credential store.
- Return the CLI's repository, Worker version, deployment, URL, and health-check result without inventing missing values.
