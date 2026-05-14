// Zitadel Action v2 payload shapes — only the fields we actually consume.
// See: https://github.com/zitadel/zitadel/blob/main/apps/docs/content/guides/integrate/actions/usage.mdx

export interface ZitadelPreAccessTokenPayload {
  function?: string;
  user?: { id?: string };
  org?: { id?: string };
  // user_grants/user_metadata/userinfo exist but we don't need them for the
  // Untenanted bridge — tenants come from the domain storage.
}

export interface ZitadelPreAccessTokenResponse {
  append_claims?: Array<{ key: string; value: unknown }>;
  set_user_metadata?: Array<{ key: string; value: string }>;
  append_log_claims?: string[];
}

export interface ZitadelEventPayload {
  aggregateID?: string;
  aggregateId?: string;
  event_type?: string;
  eventType?: string;
}

/** Minimal contract the adapter needs from the IAM service of the host app. */
export interface IamLookupForAdapter {
  listUserTenants(
    userId: string,
    orgId: string
  ): Promise<Array<{ tenantId: string; effectiveRoles: string[] }>>;
  deleteAllUserAuthz(userId: string): Promise<number>;
  deleteAllOrgAuthz(orgId: string): Promise<number>;
}
