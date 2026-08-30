// Meta Marketing API (Graph API) transport client — A4. Authenticated, rate-aware, retrying.
// Transport only: `get()` takes an arbitrary path/params and returns the parsed JSON body
// verbatim — no knowledge of campaigns, ad sets, insights or any other Meta resource. That
// normalization is Phase B's job (B2/B3).

import { createHmac } from "node:crypto";
import { META_AD_ACCOUNT_ID, META_API_VERSION } from "../../../scripts/config.ts";
import { getSecret } from "@shared/secrets/client.ts";
import { SECRET_NAMES } from "@shared/secrets/names.ts";
import { ApiError } from "../http/errors.ts";
import { withRetry } from "../http/retry.ts";
import { sleep as realSleep } from "../http/sleep.ts";
import {
  decideBucBackoff,
  parseBucHeader,
  type BucThrottleDecision,
  type ParsedBucUsage,
} from "./buc.ts";
import { classifyMetaError } from "./errors.ts";

export interface MetaClientOptions {
  accessToken: string;
  /** Used to compute `appsecret_proof` (Meta's "Require App Secret" hardening) when present.
   * Optional because it's harmless — but not required — for an app that doesn't enforce it. */
  appSecret?: string;
  apiVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** §7.1 pre-emptive backoff threshold — default 90%, see meta/buc.ts. */
  throttleThresholdPercent?: number;
  onThrottle?: (decision: BucThrottleDecision) => void;
}

export interface MetaGetResult<T> {
  data: T;
  usage: ParsedBucUsage | null;
}

export class MetaClient {
  private readonly accessToken: string;
  private readonly appSecret: string | undefined;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly throttleThresholdPercent: number;
  private readonly onThrottle: ((decision: BucThrottleDecision) => void) | undefined;
  private lastUsage: ParsedBucUsage | null = null;

  constructor(opts: MetaClientOptions) {
    this.accessToken = opts.accessToken;
    this.appSecret = opts.appSecret;
    this.apiVersion = opts.apiVersion ?? META_API_VERSION;
    this.baseUrl = opts.baseUrl ?? "https://graph.facebook.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? realSleep;
    this.throttleThresholdPercent = opts.throttleThresholdPercent ?? 90;
    this.onThrottle = opts.onThrottle;
  }

  /** The most recently observed `X-Business-Use-Case-Usage` state, or `null` before any
   * request has completed. Exposed for callers (health checks, logging) that want to inspect
   * throttle state without making a request. */
  getLastUsage(): ParsedBucUsage | null {
    return this.lastUsage;
  }

  /**
   * One GET against the Graph API. Handles, in order: pre-emptive BUC backoff (waits before
   * sending if the last response indicated high usage), the request itself with retry on
   * retryable failures, and BUC header parsing on the response (stored for the *next* call's
   * pre-emptive check — this is what makes the backoff pre-emptive rather than reactive).
   */
  async get<T = unknown>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<MetaGetResult<T>> {
    return this.request<T>("GET", path, params);
  }

  /**
   * One POST against the Graph API — B3 needs this to submit an async insights report job
   * (`POST /{ad_account_id}/insights` returns `{report_run_id}`; Meta's async report submission
   * is a POST, not a GET). Same BUC/retry handling as `get()`; parameters (including the token
   * and `appsecret_proof`) go in a form-encoded body rather than the query string, matching how
   * the Graph API itself accepts POST bodies.
   */
  async post<T = unknown>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<MetaGetResult<T>> {
    return this.request<T>("POST", path, params);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string>,
  ): Promise<MetaGetResult<T>> {
    await this.preemptiveThrottle();

    return withRetry(
      async () => {
        const res =
          method === "GET"
            ? await this.fetchImpl(this.buildUrl(path, params))
            : await this.fetchImpl(`${this.baseUrl}/${this.apiVersion}${path}`, {
                method: "POST",
                body: this.buildBody(params),
              });

        this.lastUsage = parseBucHeader(res.headers.get("x-business-use-case-usage"));

        const body: unknown = await res.json().catch(() => undefined);
        if (!res.ok || (typeof body === "object" && body !== null && "error" in body)) {
          throw classifyMetaError(res.status, body);
        }
        return { data: body as T, usage: this.lastUsage };
      },
      { sleep: this.sleepImpl },
    );
  }

  private buildBody(params: Record<string, string>): URLSearchParams {
    const body = new URLSearchParams(params);
    body.set("access_token", this.accessToken);
    if (this.appSecret) {
      body.set("appsecret_proof", this.computeAppSecretProof());
    }
    return body;
  }

  /**
   * §9.6's health check: one minimal live call, classified into authorized/not. Uses the
   * same "fetch the ad account" call A0's verify-credentials.ts established as the minimal
   * live proof of a working Meta credential — this is not a "fetch entities" call in the
   * Phase B sense (nothing is normalized or stored), just the cheapest authenticated request
   * available. Does not attempt to distinguish `no_new_data` — see services/ingest/health.ts
   * for why that needs a row count only the actual sync task has.
   */
  async checkAuth(
    adAccountId: string = META_AD_ACCOUNT_ID,
  ): Promise<{ authorized: boolean; detail: string }> {
    try {
      const result = await this.get<{ id?: string }>(`/${adAccountId}`, { fields: "id" });
      return { authorized: true, detail: `account id: ${result.data.id ?? adAccountId}` };
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unauthorized") {
        return { authorized: false, detail: err.message };
      }
      throw err;
    }
  }

  private buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}/${this.apiVersion}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("access_token", this.accessToken);
    if (this.appSecret) {
      url.searchParams.set("appsecret_proof", this.computeAppSecretProof());
    }
    return url.toString();
  }

  private computeAppSecretProof(): string {
    return createHmac("sha256", this.appSecret as string)
      .update(this.accessToken)
      .digest("hex");
  }

  private async preemptiveThrottle(): Promise<void> {
    const decision = decideBucBackoff(this.lastUsage, {
      thresholdPercent: this.throttleThresholdPercent,
    });
    if (decision.shouldThrottle) {
      this.onThrottle?.(decision);
      await this.sleepImpl(decision.waitMs);
    }
  }
}

/**
 * Resolves the Meta system-user token and app secret from Secret Manager (by the exact A0
 * names — SECRET_NAMES.metaSystemUserToken / .metaAppSecret) and builds a ready client.
 * Every other option can still be overridden, e.g. for tests: `createMetaClient({ fetchImpl })`.
 */
export async function createMetaClient(opts: Partial<MetaClientOptions> = {}): Promise<MetaClient> {
  const accessToken = opts.accessToken ?? (await getSecret(SECRET_NAMES.metaSystemUserToken));
  const appSecret = opts.appSecret ?? (await getSecret(SECRET_NAMES.metaAppSecret));
  return new MetaClient({ ...opts, accessToken, appSecret });
}
