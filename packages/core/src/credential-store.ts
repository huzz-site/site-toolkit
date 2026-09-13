import { AsyncEntry } from "@napi-rs/keyring";

import { SiteError } from "./errors.js";

export const CREDENTIAL_SERVICE = "huzz-site-toolkit.cloudflare";

export interface CredentialStore {
  get(accountId: string): Promise<string | undefined>;
  set(accountId: string, token: string): Promise<void>;
  delete(accountId: string): Promise<boolean>;
}

function entry(accountId: string): AsyncEntry {
  return new AsyncEntry(CREDENTIAL_SERVICE, accountId);
}

function unavailable(operation: string, accountId: string, cause: unknown): SiteError {
  return new SiteError(
    "CREDENTIAL_STORE_UNAVAILABLE",
    `System credential store is unavailable during ${operation}`,
    { accountId, operation },
    { cause },
  );
}

export class SystemCredentialStore implements CredentialStore {
  async get(accountId: string): Promise<string | undefined> {
    try {
      return await entry(accountId).getPassword();
    } catch (error) {
      throw unavailable("read", accountId, error);
    }
  }

  async set(accountId: string, token: string): Promise<void> {
    try {
      await entry(accountId).setPassword(token);
    } catch (error) {
      throw unavailable("write", accountId, error);
    }
  }

  async delete(accountId: string): Promise<boolean> {
    try {
      return await entry(accountId).deletePassword();
    } catch (error) {
      throw unavailable("delete", accountId, error);
    }
  }
}
