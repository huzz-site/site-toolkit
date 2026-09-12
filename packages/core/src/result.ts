import { SCHEMA_VERSION } from "./constants.js";
import type { SiteError } from "./errors.js";

export interface SuccessOutput<T> {
  readonly schemaVersion: number;
  readonly ok: true;
  readonly command: string;
  readonly site?: string;
  readonly result: T;
  readonly warnings: readonly string[];
}

export interface ErrorOutput {
  readonly schemaVersion: number;
  readonly ok: false;
  readonly command: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly exitCode: number;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

export function success<T>(
  command: string,
  result: T,
  options: { readonly site?: string; readonly warnings?: readonly string[] } = {},
): SuccessOutput<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    command,
    ...(options.site === undefined ? {} : { site: options.site }),
    result,
    warnings: options.warnings ?? [],
  };
}

export function failure(command: string, error: SiteError): ErrorOutput {
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    command,
    error: {
      code: error.code,
      message: error.message,
      exitCode: error.exitCode,
      details: error.details,
    },
  };
}
