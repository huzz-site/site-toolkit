import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";

import {
  GITHUB_ORGANIZATION,
  SCHEMA_VERSION,
  SITE_CONFIG_FILE,
  WORKSPACE_CONFIG_FILE,
  WRANGLER_CONFIG_FILE,
} from "./constants.js";
import { SiteError } from "./errors.js";

export const workspaceConfigSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  organization: z.literal(GITHUB_ORGANIZATION),
  cloudflare: z.object({
    accountId: z.string().min(1),
    accountName: z.string().min(1),
  }),
});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export const siteConfigSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  displayName: z.string().min(1).max(120),
  template: z.literal("vue"),
  templateVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  packageManager: z.literal("pnpm"),
  build: z.object({
    command: z.literal("pnpm"),
    args: z.array(z.string()).min(1),
    output: z.string().min(1),
  }),
  healthChecks: z.array(z.url()).min(1),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

const wranglerConfigSchema = z.object({
  name: z.string().min(1),
  account_id: z.string().min(1),
  compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  main: z.string().optional(),
  assets: z.object({
    not_found_handling: z.literal("single-page-application"),
  }),
});

export type WranglerConfig = z.infer<typeof wranglerConfigSchema>;

async function readAndParseJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new SiteError("SITE_CONFIG_INVALID", `Cannot read JSON configuration: ${path}`, { path }, { cause: error });
  }
}

export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig> {
  const path = join(root, WORKSPACE_CONFIG_FILE);
  const parsed = workspaceConfigSchema.safeParse(await readAndParseJson(path));
  if (!parsed.success) {
    throw new SiteError("WORKSPACE_INVALID", "Workspace configuration is invalid", {
      path,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export async function loadSiteConfig(root: string): Promise<SiteConfig> {
  const path = join(root, SITE_CONFIG_FILE);
  const parsed = siteConfigSchema.safeParse(await readAndParseJson(path));
  if (!parsed.success) {
    throw new SiteError("SITE_CONFIG_INVALID", "Site configuration is invalid", {
      path,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export async function loadWranglerConfig(root: string): Promise<WranglerConfig> {
  const path = join(root, WRANGLER_CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new SiteError("SITE_CONFIG_INVALID", `Cannot read Wrangler configuration: ${path}`, { path }, { cause: error });
  }
  const errors: Array<{ error: number; offset: number; length: number }> = [];
  const value = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new SiteError("SITE_CONFIG_INVALID", "Wrangler JSONC is invalid", { path, errors });
  }
  const parsed = wranglerConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new SiteError("SITE_CONFIG_INVALID", "Wrangler configuration is invalid", {
      path,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function writeWorkspaceConfig(root: string, value: WorkspaceConfig): Promise<void> {
  await writeJsonAtomic(join(root, WORKSPACE_CONFIG_FILE), workspaceConfigSchema.parse(value));
}
