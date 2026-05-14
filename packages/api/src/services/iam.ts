import type { UserAuthzRepository } from "../repos/user-authz.js";
import type { OrgAuthzRepository } from "../repos/org-authz.js";
import type {
  EffectiveTenantAccess,
  ValidateExchangeResponse,
} from "@untenanted/types";

/**
 * Aggregated IAM service: composes USER_TENANT_AUTHORIZATION and
 * ORG_TENANT_AUTHORIZATION rows into effective access. Matches spec §6 and §11.
 *
 * `org_id` is required input because the API is IdP-agnostic — it does not call
 * out to the IdP to resolve a user's org. Callers provide it from the token
 * claim (self-service) or from the normalized webhook payload (validate-exchange).
 */
export class IamService {
  constructor(
    private readonly userAuthz: UserAuthzRepository,
    private readonly orgAuthz: OrgAuthzRepository
  ) {}

  async listUserTenants(
    userId: string,
    orgId: string
  ): Promise<EffectiveTenantAccess[]> {
    const [direct, viaOrg] = await Promise.all([
      this.userAuthz.listByUser(userId),
      this.orgAuthz.listByOrg(orgId),
    ]);
    const merged = new Map<
      string,
      { roles: Set<string>; paths: Set<"direct" | "org"> }
    >();
    for (const a of direct) {
      const entry = merged.get(a.tenantId) ?? {
        roles: new Set<string>(),
        paths: new Set<"direct" | "org">(),
      };
      a.roles.forEach((r) => entry.roles.add(r));
      entry.paths.add("direct");
      merged.set(a.tenantId, entry);
    }
    for (const a of viaOrg) {
      const entry = merged.get(a.tenantId) ?? {
        roles: new Set<string>(),
        paths: new Set<"direct" | "org">(),
      };
      a.roles.forEach((r) => entry.roles.add(r));
      entry.paths.add("org");
      merged.set(a.tenantId, entry);
    }
    const out: EffectiveTenantAccess[] = [];
    for (const [tenantId, { roles, paths }] of merged.entries()) {
      out.push({
        tenantId,
        effectiveRoles: [...roles].sort(),
        paths: [...paths].sort(),
      });
    }
    out.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
    return out;
  }

  async effectiveRoles(
    userId: string,
    orgId: string,
    tenantId: string
  ): Promise<Set<string>> {
    const all = await this.listUserTenants(userId, orgId);
    const hit = all.find((t) => t.tenantId === tenantId);
    return new Set(hit?.effectiveRoles ?? []);
  }

  /**
   * Spec §8: validates that every requested scope is present in the effective
   * roles of every requested tid. Full-fail with detailed missing map.
   */
  async validateExchange(
    userId: string,
    orgId: string,
    requestedTids: string[],
    requestedScopes: string[]
  ): Promise<ValidateExchangeResponse> {
    const accessible = new Map<string, Set<string>>();
    for (const t of await this.listUserTenants(userId, orgId)) {
      accessible.set(t.tenantId, new Set(t.effectiveRoles));
    }
    const missing: Record<string, string[]> = {};
    for (const tid of requestedTids) {
      const eff = accessible.get(tid) ?? new Set<string>();
      const lacking = requestedScopes.filter((s) => !eff.has(s));
      if (lacking.length > 0) missing[tid] = lacking;
    }
    if (Object.keys(missing).length > 0) {
      return { ok: false, missing };
    }
    return { ok: true, effectiveScopes: [...requestedScopes].sort() };
  }

  /**
   * Spec §12: delegation rule — caller can only grant roles they themselves
   * possess in the tenant.
   */
  async canDelegate(
    callerUserId: string,
    callerOrgId: string,
    tenantId: string,
    requestedRoles: string[]
  ): Promise<{ ok: true } | { ok: false; missing: string[] }> {
    const eff = await this.effectiveRoles(callerUserId, callerOrgId, tenantId);
    const missing = requestedRoles.filter((r) => !eff.has(r));
    if (missing.length > 0) return { ok: false, missing };
    return { ok: true };
  }
}
