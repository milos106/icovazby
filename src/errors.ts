export type AresErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR";

export class AresError extends Error {
  readonly code: AresErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AresErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AresError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.details ?? {}),
    };
  }
}

export class NotFoundError extends AresError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export class InvalidInputError extends AresError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("INVALID_INPUT", message, details);
    this.name = "InvalidInputError";
  }
}

export class RateLimitedError extends AresError {
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number, details?: Record<string, unknown>) {
    super("RATE_LIMITED", message, { ...details, retryAfterSeconds });
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class UpstreamError extends AresError {
  readonly status?: number;

  constructor(message: string, status?: number, details?: Record<string, unknown>) {
    super("UPSTREAM_ERROR", message, { ...details, status });
    this.name = "UpstreamError";
    this.status = status;
  }
}

export class NetworkError extends AresError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NETWORK_ERROR", message, details);
    this.name = "NetworkError";
  }
}

export function mapHttpStatusToAresError(
  status: number,
  message: string,
  retryAfterSeconds?: number,
): AresError {
  if (status === 404) return new NotFoundError(message);
  if (status === 400 || status === 422) return new InvalidInputError(message);
  if (status === 429) return new RateLimitedError(message, retryAfterSeconds);
  if (status >= 500) return new UpstreamError(message, status);
  return new UpstreamError(message, status);
}

export function toToolErrorPayload(err: unknown): {
  error: AresErrorCode | "UNKNOWN";
  message: string;
  details?: Record<string, unknown>;
} {
  if (err instanceof AresError) {
    return { error: err.code, message: err.message, details: err.details };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: "UNKNOWN", message };
}
