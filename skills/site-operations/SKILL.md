---
name: site-operations
description: Create, validate, deploy, inspect, or roll back websites managed by the huzz-site Site Toolkit CLI. Use only for repositories that contain site.config.json; do not use for unrelated Cloudflare projects.
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

- Inspect readiness: `doctor`
- Create and deploy a repository: `create <repository> --display-name <name> --domain <domain> [--alias <domain>] <--with-backend|--no-backend> --visibility <private|public>`
- Validate without upload: `check` or `deploy --dry-run`
- Deploy the current committed site: `deploy`
- Inspect the current deployment: `status`
- List Worker versions: `versions`
- Roll back: `rollback --previous` or `rollback --to <version-id>`

For `create`, require the repository, display name, primary domain, backend choice, and visibility to be explicit. Never infer a Cloudflare Account; `site init` owns that selection.

## Boundaries

- Do not call `gh`, `wrangler`, Cloudflare APIs, or GitHub APIs to perform a write that the CLI owns.
- Do not deploy or roll back unless the user explicitly requested that mutation. Creating a site includes its first deployment.
- Do not expose destructive deletion or account-switching workflows.
- On authentication, permission, credential, or `USER_INPUT_REQUIRED` errors, stop and ask the user to run interactive `site init`; do not work around the CLI.
- Return the CLI's repository, Worker version, deployment, URL, and health-check result without inventing missing values.
