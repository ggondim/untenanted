import type {
  Tenant,
  CreateTenantRequest,
  UpdateTenantRequest,
  ListTenantsResponse,
  ListUserTenantsResponse,
  ListTenantUsersResponse,
  ListTenantOrgsResponse,
  ListOrgTenantsResponse,
  GrantUserTenantRequest,
  GrantOrgTenantRequest,
  UserTenantAuthorization,
  OrgTenantAuthorization,
  ValidateExchangeRequest,
  ValidateExchangeResponse,
  NormalizedWebhookEvent,
} from "@untenanted/types";

export interface UntenantedClientOptions {
  baseUrl: string;
  /** Returns a bearer access token to be sent as `Authorization: Bearer ...`. */
  getToken?: () => string | Promise<string>;
  /** Returns the current tenant token, sent as the `tenant-token` header. */
  getTenantToken?: () => string | Promise<string | undefined> | undefined;
  /** Override the global fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Default request headers merged into every call. */
  defaultHeaders?: Record<string, string>;
}

export class UntenantedHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly url: string
  ) {
    super(`untenanted http ${status} at ${url}`);
    this.name = "UntenantedHttpError";
  }
}

interface RequestInit2 {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Extra headers (e.g. X-Internal-Auth) for special endpoints. */
  headers?: Record<string, string>;
  /** Skip bearer/tenant injection for endpoints with their own auth. */
  bypassAuth?: boolean;
}

export class UntenantedClient {
  private readonly fetchImpl: typeof fetch;

  readonly tenants: TenantsApi;
  readonly iam: IamApi;
  readonly internal: InternalApi;
  readonly webhooks: WebhooksApi;

  constructor(private readonly opts: UntenantedClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tenants = new TenantsApi(this);
    this.iam = new IamApi(this);
    this.internal = new InternalApi(this);
    this.webhooks = new WebhooksApi(this);
  }

  /** @internal */
  async request<T>(init: RequestInit2): Promise<T> {
    const url = new URL(init.path, ensureTrailingSlash(this.opts.baseUrl));
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(this.opts.defaultHeaders ?? {}),
      ...(init.headers ?? {}),
    };
    if (!init.bypassAuth) {
      if (this.opts.getToken) {
        const t = await this.opts.getToken();
        if (t) headers.authorization = `Bearer ${t}`;
      }
      if (this.opts.getTenantToken) {
        const tt = await this.opts.getTenantToken();
        if (tt) headers["tenant-token"] = tt;
      }
    }
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const res = await this.fetchImpl(url.toString(), {
      method: init.method,
      headers,
      body,
    });
    const text = await res.text();
    const parsed: unknown =
      text.length > 0 && res.headers.get("content-type")?.includes("application/json")
        ? safeJson(text)
        : text;
    if (!res.ok) {
      throw new UntenantedHttpError(res.status, parsed, url.toString());
    }
    return parsed as T;
  }
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith("/") ? s : s + "/";
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ---------- Sub-clients ----------

class TenantsApi {
  constructor(private readonly c: UntenantedClient) {}

  list(query: { limit?: number; cursor?: string; status?: string; ownerOrgId?: string } = {}): Promise<ListTenantsResponse> {
    return this.c.request({ method: "GET", path: "tenants", query });
  }
  get(id: string): Promise<Tenant> {
    return this.c.request({ method: "GET", path: `tenants/${encodeURIComponent(id)}` });
  }
  create(body: CreateTenantRequest): Promise<Tenant> {
    return this.c.request({ method: "POST", path: "tenants", body });
  }
  update(id: string, body: UpdateTenantRequest): Promise<Tenant> {
    return this.c.request({
      method: "PATCH",
      path: `tenants/${encodeURIComponent(id)}`,
      body,
    });
  }
  delete(id: string): Promise<void> {
    return this.c.request({
      method: "DELETE",
      path: `tenants/${encodeURIComponent(id)}`,
    });
  }
}

class IamApi {
  constructor(private readonly c: UntenantedClient) {}

  listMyTenants(): Promise<ListUserTenantsResponse> {
    return this.c.request({ method: "GET", path: "iam/users/me/tenants" });
  }
  listUserTenants(userId: string, orgId: string): Promise<ListUserTenantsResponse> {
    return this.c.request({
      method: "GET",
      path: `iam/users/${encodeURIComponent(userId)}/tenants`,
      query: { orgId },
    });
  }
  listTenantUsers(tenantId: string): Promise<ListTenantUsersResponse> {
    return this.c.request({
      method: "GET",
      path: `iam/tenants/${encodeURIComponent(tenantId)}/users`,
    });
  }
  listTenantOrgs(tenantId: string): Promise<ListTenantOrgsResponse> {
    return this.c.request({
      method: "GET",
      path: `iam/tenants/${encodeURIComponent(tenantId)}/organizations`,
    });
  }
  listOrgTenants(orgId: string): Promise<ListOrgTenantsResponse> {
    return this.c.request({
      method: "GET",
      path: `iam/organizations/${encodeURIComponent(orgId)}/tenants`,
    });
  }
  grantUserAccess(
    userId: string,
    tenantId: string,
    body: GrantUserTenantRequest
  ): Promise<UserTenantAuthorization> {
    return this.c.request({
      method: "POST",
      path: `iam/users/${encodeURIComponent(userId)}/tenants/${encodeURIComponent(tenantId)}`,
      body,
    });
  }
  revokeUserAccess(userId: string, tenantId: string): Promise<void> {
    return this.c.request({
      method: "DELETE",
      path: `iam/users/${encodeURIComponent(userId)}/tenants/${encodeURIComponent(tenantId)}`,
    });
  }
  grantOrgAccess(
    orgId: string,
    tenantId: string,
    body: GrantOrgTenantRequest
  ): Promise<OrgTenantAuthorization> {
    return this.c.request({
      method: "POST",
      path: `iam/organizations/${encodeURIComponent(orgId)}/tenants/${encodeURIComponent(tenantId)}`,
      body,
    });
  }
  revokeOrgAccess(orgId: string, tenantId: string): Promise<void> {
    return this.c.request({
      method: "DELETE",
      path: `iam/organizations/${encodeURIComponent(orgId)}/tenants/${encodeURIComponent(tenantId)}`,
    });
  }
}

class InternalApi {
  constructor(private readonly c: UntenantedClient) {}

  /**
   * Called from the IdP adapter to validate a token-exchange request.
   * Requires the shared `X-Internal-Auth` secret.
   */
  validateExchange(
    body: ValidateExchangeRequest,
    sharedSecret: string,
    headerName = "x-internal-auth"
  ): Promise<ValidateExchangeResponse> {
    return this.c.request({
      method: "POST",
      path: "iam/internal/validate-exchange",
      body,
      headers: { [headerName]: sharedSecret },
      bypassAuth: true,
    });
  }
}

class WebhooksApi {
  constructor(private readonly c: UntenantedClient) {}

  send(
    event: NormalizedWebhookEvent,
    sharedSecret: string,
    headerName = "x-webhook-auth"
  ): Promise<{ ok: true; type: string; affected: number }> {
    return this.c.request({
      method: "POST",
      path: "webhooks/events",
      body: event,
      headers: { [headerName]: sharedSecret },
      bypassAuth: true,
    });
  }
}
