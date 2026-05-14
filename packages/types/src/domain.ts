import { z } from "zod";

export const TenantStatus = z.enum(["active", "suspended", "archived"]);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const Tenant = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ownerOrgId: z.string().nullable(),
  status: TenantStatus,
  plan: z.string().nullable(),
  properties: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type Tenant = z.infer<typeof Tenant>;

export const UserTenantAuthorization = z.object({
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  roles: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type UserTenantAuthorization = z.infer<typeof UserTenantAuthorization>;

export const OrgTenantAuthorization = z.object({
  orgId: z.string().min(1),
  tenantId: z.string().min(1),
  roles: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type OrgTenantAuthorization = z.infer<typeof OrgTenantAuthorization>;

export const AccessPath = z.enum(["direct", "org"]);
export type AccessPath = z.infer<typeof AccessPath>;

export const EffectiveTenantAccess = z.object({
  tenantId: z.string().min(1),
  effectiveRoles: z.array(z.string()),
  paths: z.array(AccessPath),
});
export type EffectiveTenantAccess = z.infer<typeof EffectiveTenantAccess>;
