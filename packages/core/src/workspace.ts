import { access, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SITE_CONFIG_FILE, WORKSPACE_CONFIG_FILE } from "./constants.js";
import { SiteError } from "./errors.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findUp(start: string, marker: string): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    if (await exists(join(current, marker))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function findWorkspaceRoot(start: string): Promise<string> {
  const root = await findUp(start, WORKSPACE_CONFIG_FILE);
  if (!root) {
    throw new SiteError("WORKSPACE_NOT_INITIALIZED", "No initialized site workspace was found", {
      start: resolve(start),
      marker: WORKSPACE_CONFIG_FILE,
    });
  }
  return root;
}

export async function findSiteRoot(start: string): Promise<string> {
  const root = await findUp(start, SITE_CONFIG_FILE);
  if (!root) {
    throw new SiteError("SITE_NOT_FOUND", "No managed site was found", {
      start: resolve(start),
      marker: SITE_CONFIG_FILE,
    });
  }
  return root;
}

export async function directoryIsEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    throw error;
  }
}

export { exists };
