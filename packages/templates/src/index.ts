import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATE_VERSION = "1.1.0";
export const WRANGLER_VERSION = "4.131.1";

export interface RenderVueTemplateOptions {
  readonly targetDirectory: string;
  readonly repository: string;
  readonly siteId: string;
  readonly displayName: string;
  readonly accountId: string;
  readonly domain?: string;
  readonly aliases: readonly string[];
  readonly withBackend: boolean;
  readonly compatibilityDate?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function copyTemplateDirectory(
  source: string,
  target: string,
  replacements: Readonly<Record<string, string>>,
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const outputName = entry.name.endsWith(".tpl") ? entry.name.slice(0, -4) : entry.name;
    const targetPath = join(target, outputName);

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyTemplateDirectory(sourcePath, targetPath, replacements);
      continue;
    }

    let content = await readFile(sourcePath, "utf8");
    for (const [token, value] of Object.entries(replacements)) {
      content = content.replaceAll(token, value);
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }
}

function packageJson(options: RenderVueTemplateOptions): Record<string, unknown> {
  return {
    name: options.repository,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node: "^22.18.0 || >=24.12.0" },
    packageManager: "pnpm@11.19.0",
    scripts: {
      dev: "vite",
      build: "vue-tsc --build && vite build",
      preview: "pnpm build && wrangler dev",
      typecheck: "vue-tsc --build --force",
      test: "vitest run",
      "cf-typegen": "wrangler types",
      deploy: "pnpm build && wrangler deploy",
    },
    dependencies: { vue: "3.5.42" },
    devDependencies: {
      "@cloudflare/vite-plugin": "1.54.8",
      "@cloudflare/workers-types": "5.20260911.1",
      "@types/node": "22.20.2",
      "@vitejs/plugin-vue": "6.0.8",
      typescript: "6.0.3",
      vite: "8.3.0",
      vitest: "5.0.0",
      "vue-tsc": "3.3.11",
      wrangler: WRANGLER_VERSION,
    },
  };
}

function siteConfig(options: RenderVueTemplateOptions): Record<string, unknown> {
  const healthChecks = options.domain === undefined
    ? []
    : options.withBackend
      ? [`https://${options.domain}`, `https://${options.domain}/api/health`]
      : [`https://${options.domain}`];
  return {
    $schema: "https://raw.githubusercontent.com/huzz-site/site-toolkit/v1/schemas/site.schema.json",
    version: 1,
    id: options.siteId,
    displayName: options.displayName,
    template: "vue",
    templateVersion: TEMPLATE_VERSION,
    packageManager: "pnpm",
    build: {
      command: "pnpm",
      args: ["build"],
      output: "dist",
    },
    healthChecks,
  };
}

function wranglerConfig(options: RenderVueTemplateOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: options.siteId,
    account_id: options.accountId,
    compatibility_date: options.compatibilityDate ?? new Date().toISOString().slice(0, 10),
    compatibility_flags: ["nodejs_compat"],
    assets: {
      not_found_handling: "single-page-application",
      ...(options.withBackend ? { run_worker_first: ["/api/*"] } : {}),
    },
    workers_dev: options.domain === undefined,
    ...(options.domain === undefined
      ? {}
      : {
          routes: [options.domain, ...options.aliases].map((pattern) => ({
            pattern,
            custom_domain: true,
          })),
        }),
    observability: { enabled: true },
    upload_source_maps: true,
  };
  if (options.withBackend) config.main = "server/index.ts";
  return config;
}

function tsconfig(options: RenderVueTemplateOptions): Record<string, unknown> {
  const references: Array<Record<string, string>> = [
    { path: "./tsconfig.app.json" },
    { path: "./tsconfig.node.json" },
  ];
  if (options.withBackend) references.push({ path: "./tsconfig.worker.json" });
  return { files: [], references };
}

export async function renderVueTemplate(options: RenderVueTemplateOptions): Promise<void> {
  const templateRoot = fileURLToPath(new URL("../vue", import.meta.url));
  await mkdir(options.targetDirectory, { recursive: true });
  await copyTemplateDirectory(templateRoot, options.targetDirectory, {
    __DISPLAY_NAME__: escapeHtml(options.displayName),
    __SITE_ID__: options.siteId,
    __BACKEND_ENABLED__: String(options.withBackend),
  });

  if (!options.withBackend) {
    const { rm } = await import("node:fs/promises");
    await rm(join(options.targetDirectory, "server"), { recursive: true, force: true });
    await rm(join(options.targetDirectory, "tests", "api.test.ts"), { force: true });
    await rm(join(options.targetDirectory, "tsconfig.worker.json"), { force: true });
  }

  const jsonFiles: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["package.json", packageJson(options)],
    ["site.config.json", siteConfig(options)],
    ["wrangler.jsonc", wranglerConfig(options)],
    ["tsconfig.json", tsconfig(options)],
  ];
  for (const [name, value] of jsonFiles) {
    await writeFile(join(options.targetDirectory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}
