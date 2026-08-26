import { JamError } from "../../domain/errors.js";
import type { CredentialPort, JiraCredentials } from "../../ports/credentials.port.js";

export type JiraRequest = {
  path: string;
  method?: "GET" | "POST" | "PUT";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /**
   * Whether a transient failure may be retried.
   *
   * Reads say yes and get the retry loop below. Writes say no: a request that
   * timed out may already have been applied, so resending it is how one
   * comment becomes two. The write path resolves that ambiguity by reading the
   * issue back, never by trying again.
   */
  retry?: boolean;
};

export type JiraResponse<T> = {
  data: T;
  /** Size of the raw response body, for telemetry and budget accounting. */
  bytes: number;
};

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 5_000;

/**
 * Thin HTTP boundary around Jira Cloud REST v3.
 *
 * Two hard rules live here:
 *  1. The Authorization header is built at request time and never stored,
 *     logged, or attached to a thrown error.
 *  2. Every non-2xx response becomes a JamError with a normalized code, so no
 *     vendor error shape escapes the adapter.
 */
export class JiraClient {
  private cached?: JiraCredentials;

  constructor(
    private readonly credentials: CredentialPort,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get baseUrl(): string {
    return this.creds().baseUrl;
  }

  private creds(): JiraCredentials {
    this.cached ??= this.credentials.load();
    return this.cached;
  }

  async request<T>(req: JiraRequest): Promise<JiraResponse<T>> {
    const creds = this.creds();
    const url = new URL(req.path, `${creds.baseUrl}/`);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64");

    let lastError: JamError | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: req.method ?? "GET",
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/json",
            ...(req.body ? { "Content-Type": "application/json" } : {}),
          },
          ...(req.body ? { body: JSON.stringify(req.body) } : {}),
        });
      } catch (err) {
        // Network-level failure: the message may contain the host but never the token.
        throw new JamError(
          "JIRA_UNAVAILABLE",
          `Could not reach Jira at ${creds.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const text = await res.text();
      const bytes = Buffer.byteLength(text, "utf8");

      if (res.ok) {
        if (!text) return { data: undefined as T, bytes };
        try {
          return { data: JSON.parse(text) as T, bytes };
        } catch {
          throw new JamError("JIRA_UNAVAILABLE", "Jira returned a non-JSON response.");
        }
      }

      const error = mapStatus(res.status, text, url.pathname);
      // ponytail: fixed 2 retries on transient statuses; add backoff tuning if
      // `complete` searches start tripping Jira's rate limiter in practice.
      const transient = res.status === 429 || res.status >= 500;
      if (req.retry !== false && transient && attempt < MAX_RETRIES) {
        lastError = error;
        await sleep(retryDelayMs(res.headers.get("retry-after"), attempt));
        continue;
      }
      throw error;
    }

    throw lastError ?? new JamError("JIRA_UNAVAILABLE", "Jira request failed.");
  }
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const parsed = retryAfter ? Number(retryAfter) * 1000 : NaN;
  const fallback = 500 * 2 ** attempt;
  const delay = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract Jira's own message without echoing the whole payload back to the agent.
 */
function jiraMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
      message?: string;
    };
    const fromList = parsed.errorMessages?.filter(Boolean).join(" ");
    if (fromList) return fromList;
    const fromMap = parsed.errors
      ? Object.entries(parsed.errors)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" ")
      : "";
    if (fromMap) return fromMap;
    if (parsed.message) return parsed.message;
  } catch {
    // fall through - a non-JSON error body is not worth forwarding verbatim
  }
  return undefined;
}

export function mapStatus(status: number, body: string, path: string): JamError {
  const detail = jiraMessage(body);
  const suffix = detail ? ` ${detail}` : "";

  switch (status) {
    case 400:
      return new JamError(
        "JQL_INVALID",
        `Jira rejected the request as malformed.${suffix}`,
        { status },
      );
    case 401:
      return new JamError(
        "JIRA_AUTH_FAILED",
        "Jira rejected the credentials. Check JIRA_EMAIL and JIRA_API_TOKEN.",
        { status },
      );
    case 403:
      return new JamError(
        "JIRA_PERMISSION_DENIED",
        `The current Jira account is not permitted to do this.${suffix}`,
        { status },
      );
    case 404:
      return new JamError(
        "ISSUE_NOT_FOUND",
        `Jira has no such resource, or it is not visible to this account (${path}).${suffix}`,
        { status },
      );
    case 429:
      return new JamError("RATE_LIMITED", "Jira rate limit reached.", { status });
    default:
      if (status >= 500) {
        return new JamError("JIRA_UNAVAILABLE", `Jira returned ${status}.${suffix}`, {
          status,
        });
      }
      return new JamError("JIRA_UNAVAILABLE", `Jira returned ${status}.${suffix}`, {
        status,
      });
  }
}
