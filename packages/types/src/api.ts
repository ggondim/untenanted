import { z } from "zod";
import {
  Tenant,
  TenantStatus,
  EffectiveTenantAccess,
  UserTenantAuthorization,
  OrgTenantAuthorization,
} from "./domain.js";

// ---------- Tenants CRUD ----------

export const CreateTenantRequest = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ownerOrgId: z.string().nullable().optional(),
  status: TenantStatus.optional(),
  plan: z.string().nullable().optional(),
  properties: z.record(z.unknown()).optional(),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export const UpdateTenantRequest = z.object({
  name: z.string().min(1).optional(),
  ownerOrgId: z.string().nullable().optional(),
  status: TenantStatus.optional(),
  plan: z.string().nullable().optional(),
  properties: z.record(z.unknown()).optional(),
});
export type UpdateTenantRequest = z.infer<typeof UpdateTenantRequest>;

export const ListTenantsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  cursor: z.string().optional(),
  status: TenantStatus.optional(),
  ownerOrgId: z.string().optional(),
});
export type ListTenantsQuery = z.infer<typeof ListTenantsQuery>;

export const ListTenantsResponse = z.object({
  tenants: z.array(Tenant),
  nextCursor: z.string().nullable(),
});
export type ListTenantsResponse = z.infer<typeof ListTenantsResponse>;

// ---------- IAM Discovery ----------

export const ListUserTenantsResponse = z.object({
  tenants: z.array(EffectiveTenantAccess),
});
export type ListUserTenantsResponse = z.infer<typeof ListUserTenantsResponse>;

export const ListTenantUsersResponse = z.object({
  directUsers: z.array(UserTenantAuthorization),
  orgs: z.array(OrgTenantAuthorization),
});
export type ListTenantUsersResponse = z.infer<typeof ListTenantUsersResponse>;

export const ListTenantOrgsResponse = z.object({
  orgs: z.array(OrgTenantAuthorization),
});
export type ListTenantOrgsResponse = z.infer<typeof ListTenantOrgsResponse>;

export const ListOrgTenantsResponse = z.object({
  authorizations: z.array(OrgTenantAuthorization),
});
export type ListOrgTenantsResponse = z.infer<typeof ListOrgTenantsResponse>;

// ---------- IAM Mutation ----------

export const GrantUserTenantRequest = z.object({
  roles: z.array(z.string()).min(1),
});
export type GrantUserTenantRequest = z.infer<typeof GrantUserTenantRequest>;

export const GrantOrgTenantRequest = z.object({
  roles: z.array(z.string()).min(1),
});
export type GrantOrgTenantRequest = z.infer<typeof GrantOrgTenantRequest>;

// ---------- Internal: validate-exchange ----------

export const ValidateExchangeRequest = z.object({
  userId: z.string().min(1),
  orgId: z.string().min(1),
  requestedTids: z.array(z.string().min(1)).min(1),
  requestedScopes: z.array(z.string().min(1)).min(1),
});
export type ValidateExchangeRequest = z.infer<typeof ValidateExchangeRequest>;

export const ValidateExchangeOk = z.object({
  ok: z.literal(true),
  effectiveScopes: z.array(z.string()),
});
export const ValidateExchangeMissing = z.object({
  ok: z.literal(false),
  missing: z.record(z.array(z.string())),
});
export const ValidateExchangeResponse = z.union([
  ValidateExchangeOk,
  ValidateExchangeMissing,
]);
export type ValidateExchangeResponse = z.infer<typeof ValidateExchangeResponse>;

// ---------- Errors ----------

export const ErrorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
