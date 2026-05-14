/**
 * Minimal OAuth2 Token Exchange (RFC 8693) client.
 *
 * Submits `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` to the
 * configured token endpoint with the subject_token and optional resource/scope
 * parameters. Authentication can be `client_secret_basic`, `client_secret_post`,
 * or pre-provided via a custom `authorize` callback (e.g. private_key_jwt).
 */

export type ClientAuth =
  | { method: "client_secret_basic"; clientId: string; clientSecret: string }
  | { method: "client_secret_post"; clientId: string; clientSecret: string }
  | { method: "none"; clientId: string }
  | { method: "custom"; authorize: (form: URLSearchParams) => Promise<{ headers?: Record<string, string> } | void> };

export interface TokenExchangeRequest {
  subjectToken: string;
  subjectTokenType?: string;          // default: urn:ietf:params:oauth:token-type:access_token
  resource?: string | string[];       // tenant ids
  audience?: string | string[];
  scope?: string | string[];
  requestedTokenType?: string;        // default: urn:ietf:params:oauth:token-type:access_token
  actorToken?: string;
  actorTokenType?: string;
  extra?: Record<string, string>;
}

export interface TokenExchangeResponse {
  access_token: string;
  issued_token_type: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

export interface TokenExchangeError {
  error: string;
  error_description?: string;
  // App-specific fields (e.g. our API surfaces "missing")
  [key: string]: unknown;
}

export class TokenExchangeFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly body: TokenExchangeError
  ) {
    super(`token_exchange_failed: ${body.error}`);
    this.name = "TokenExchangeFailure";
  }
}

export interface TokenExchangeClientOptions {
  endpoint: string;
  auth: ClientAuth;
  fetchImpl?: typeof fetch;
}

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export class TokenExchangeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TokenExchangeClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async exchange(req: TokenExchangeRequest): Promise<TokenExchangeResponse> {
    const form = new URLSearchParams();
    form.set("grant_type", GRANT_TYPE);
    form.set("subject_token", req.subjectToken);
    form.set(
      "subject_token_type",
      req.subjectTokenType ?? ACCESS_TOKEN_TYPE
    );
    form.set(
      "requested_token_type",
      req.requestedTokenType ?? ACCESS_TOKEN_TYPE
    );

    appendMulti(form, "resource", req.resource);
    appendMulti(form, "audience", req.audience);
    if (req.scope !== undefined) {
      form.set(
        "scope",
        Array.isArray(req.scope) ? req.scope.join(" ") : req.scope
      );
    }
    if (req.actorToken) {
      form.set("actor_token", req.actorToken);
      form.set(
        "actor_token_type",
        req.actorTokenType ?? ACCESS_TOKEN_TYPE
      );
    }
    for (const [k, v] of Object.entries(req.extra ?? {})) {
      form.set(k, v);
    }

    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };

    const auth = this.opts.auth;
    switch (auth.method) {
      case "client_secret_basic": {
        const encoded = base64(`${auth.clientId}:${auth.clientSecret}`);
        headers.authorization = `Basic ${encoded}`;
        break;
      }
      case "client_secret_post": {
        form.set("client_id", auth.clientId);
        form.set("client_secret", auth.clientSecret);
        break;
      }
      case "none": {
        form.set("client_id", auth.clientId);
        break;
      }
      case "custom": {
        const out = (await auth.authorize(form)) ?? {};
        Object.assign(headers, out.headers ?? {});
        break;
      }
    }

    const res = await this.fetchImpl(this.opts.endpoint, {
      method: "POST",
      headers,
      body: form.toString(),
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      body = { error: "invalid_response", error_description: text };
    }

    if (!res.ok) {
      throw new TokenExchangeFailure(
        res.status,
        body as TokenExchangeError
      );
    }
    return body as TokenExchangeResponse;
  }
}

function appendMulti(
  form: URLSearchParams,
  key: string,
  value: string | string[] | undefined
): void {
  if (value === undefined) return;
  const list = Array.isArray(value) ? value : [value];
  for (const v of list) form.append(key, v);
}

function base64(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  // Browser/edge fallback
  return btoa(s);
}
