export type ErrorCode =
  | "VALIDATION_ERROR"
  | "DEPENDENCY_MISSING"
  | "WORKSPACE_NOT_INITIALIZED"
  | "WORKSPACE_INVALID"
  | "SITE_NOT_FOUND"
  | "SITE_CONFIG_INVALID"
  | "AUTH_GITHUB_MISSING"
  | "AUTH_GITHUB_SCOPE_INSUFFICIENT"
  | "AUTH_CLOUDFLARE_MISSING"
  | "CF_ACCOUNT_NOT_FOUND"
  | "CF_ACCOUNT_MISMATCH"
  | "CF_CI_SECRET_MISSING"
  | "RESOURCE_CONFLICT"
  | "COMMAND_FAILED"
  | "CHECK_FAILED"
  | "DEPLOY_FAILED"
  | "HEALTHCHECK_FAILED"
  | "ROLLBACK_FAILED"
  | "USER_INPUT_REQUIRED"
  | "INTERNAL_ERROR";

const EXIT_CODES: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 2,
  DEPENDENCY_MISSING: 10,
  WORKSPACE_NOT_INITIALIZED: 11,
  WORKSPACE_INVALID: 12,
  SITE_NOT_FOUND: 13,
  SITE_CONFIG_INVALID: 14,
  AUTH_GITHUB_MISSING: 20,
  AUTH_GITHUB_SCOPE_INSUFFICIENT: 21,
  AUTH_CLOUDFLARE_MISSING: 22,
  CF_ACCOUNT_NOT_FOUND: 23,
  CF_ACCOUNT_MISMATCH: 24,
  CF_CI_SECRET_MISSING: 25,
  RESOURCE_CONFLICT: 30,
  COMMAND_FAILED: 40,
  CHECK_FAILED: 41,
  DEPLOY_FAILED: 50,
  HEALTHCHECK_FAILED: 51,
  ROLLBACK_FAILED: 52,
  USER_INPUT_REQUIRED: 60,
  INTERNAL_ERROR: 70,
};

export class SiteError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SiteError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.details = details;
  }
}

export function normalizeError(error: unknown): SiteError {
  if (error instanceof SiteError) return error;
  if (error instanceof Error) {
    return new SiteError("INTERNAL_ERROR", error.message, {}, { cause: error });
  }
  return new SiteError("INTERNAL_ERROR", "Unknown error", { value: String(error) });
}
