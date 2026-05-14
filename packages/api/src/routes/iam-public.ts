import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  GrantUserTenantRequest,
  GrantOrgTenantRequest,
} from "@untenanted/types";
import { requireScope } from "@untenanted/middleware";
import type { IamService } from "../services/iam.js";
import type { UserAuthzRepository } from "../repos/user-authz.js";
import type { OrgAuthzRepository } from "../repos/org-authz.js";

export interface IamPublicDeps {
  iam: IamService;
  userAuthz: UserAuthzRepository;
  orgAuthz: OrgAuthzRepository;
  /** Configurable claim names so we read the right keys from the JWT. */
  claimOrgIdName: string;
}

const QueryOrgId = z.object({ orgId: z.string().min(1) });

export const iamPublicRoutes =
  (deps: IamPublicDeps): FastifyPluginAsync =>
  async (app: FastifyInstance) => {
    // ---- Discovery ----

    app.get("/iam/users/me/tenants", async (req, reply) => {
      const token = req.token;
      if (!token?.subject) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      if (!token.orgId) {
        return reply.code(400).send({
          error: "missing_org_claim",
          message: `token does not carry the ${deps.claimOrgIdName} claim`,
        });
      }
      const tenants = await deps.iam.listUserTenants(token.subject, token.orgId);
      return { tenants };
    });

    app.get<{ Params: { userId: string }; Querystring: { orgId?: string } }>(
      "/iam/users/:userId/tenants",
      { preHandler: requireScope("iam:read") },
      async (req, reply) => {
        const parsed = QueryOrgId.safeParse(req.query);
        if (!parsed.success) {
          return reply.code(400).send({
            error: "missing_org_id",
            message: "?orgId is required",
          });
        }
        const tenants = await deps.iam.listUserTenants(
          req.params.userId,
          parsed.data.orgId
        );
        return { tenants };
      }
    );

    app.get<{ Params: { tenantId: string } }>(
      "/iam/tenants/:tenantId/users",
      { preHandler: requireScope("iam:read") },
      async (req) => {
        const [directUsers, orgs] = await Promise.all([
          deps.userAuthz.listByTenant(req.params.tenantId),
          deps.orgAuthz.listByTenant(req.params.tenantId),
        ]);
        return { directUsers, orgs };
      }
    );

    app.get<{ Params: { tenantId: string } }>(
      "/iam/tenants/:tenantId/organizations",
      { preHandler: requireScope("iam:read") },
      async (req) => {
        const orgs = await deps.orgAuthz.listByTenant(req.params.tenantId);
        return { orgs };
      }
    );

    app.get<{ Params: { orgId: string } }>(
      "/iam/organizations/:orgId/tenants",
      { preHandler: requireScope("iam:read") },
      async (req) => {
        const authorizations = await deps.orgAuthz.listByOrg(req.params.orgId);
        return { authorizations };
      }
    );

    // ---- Mutation: requires iam:delegate + caller possesses the roles ----

    app.post<{
      Params: { userId: string; tenantId: string };
    }>(
      "/iam/users/:userId/tenants/:tenantId",
      { preHandler: requireScope("iam:delegate") },
      async (req, reply) => {
        const parsed = GrantUserTenantRequest.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: "invalid_body",
            details: parsed.error.flatten(),
          });
        }
        const token = req.token;
        if (!token?.subject || !token.orgId) {
          return reply.code(401).send({ error: "unauthenticated" });
        }
        const check = await deps.iam.canDelegate(
          token.subject,
          token.orgId,
          req.params.tenantId,
          parsed.data.roles
        );
        if (!check.ok) {
          return reply.code(403).send({
            error: "cannot_delegate",
            reason: "caller does not possess all requested roles",
            missing: check.missing,
          });
        }
        const out = await deps.userAuthz.grant(
          req.params.userId,
          req.params.tenantId,
          parsed.data.roles
        );
        return reply.code(201).send(out);
      }
    );

    app.delete<{ Params: { userId: string; tenantId: string } }>(
      "/iam/users/:userId/tenants/:tenantId",
      { preHandler: requireScope("iam:delegate") },
      async (req, reply) => {
        const token = req.token;
        if (!token?.subject || !token.orgId) {
          return reply.code(401).send({ error: "unauthenticated" });
        }
        // Self-revoke is always allowed.
        if (token.subject !== req.params.userId) {
          // Otherwise, caller must have authority over the tenant (any role in
          // it suffices for revoke per spec §12 — same authority needed to grant).
          const eff = await deps.iam.effectiveRoles(
            token.subject,
            token.orgId,
            req.params.tenantId
          );
          if (eff.size === 0) {
            return reply.code(403).send({
              error: "cannot_delegate",
              reason: "caller has no authority over the tenant",
            });
          }
        }
        const ok = await deps.userAuthz.revoke(
          req.params.userId,
          req.params.tenantId
        );
        if (!ok) return reply.code(404).send({ error: "not_found" });
        return reply.code(204).send();
      }
    );

    app.post<{ Params: { orgId: string; tenantId: string } }>(
      "/iam/organizations/:orgId/tenants/:tenantId",
      { preHandler: requireScope("iam:delegate") },
      async (req, reply) => {
        const parsed = GrantOrgTenantRequest.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: "invalid_body",
            details: parsed.error.flatten(),
          });
        }
        const token = req.token;
        if (!token?.subject || !token.orgId) {
          return reply.code(401).send({ error: "unauthenticated" });
        }
        const check = await deps.iam.canDelegate(
          token.subject,
          token.orgId,
          req.params.tenantId,
          parsed.data.roles
        );
        if (!check.ok) {
          return reply.code(403).send({
            error: "cannot_delegate",
            reason: "caller does not possess all requested roles",
            missing: check.missing,
          });
        }
        const out = await deps.orgAuthz.grant(
          req.params.orgId,
          req.params.tenantId,
          parsed.data.roles
        );
        return reply.code(201).send(out);
      }
    );

    app.delete<{ Params: { orgId: string; tenantId: string } }>(
      "/iam/organizations/:orgId/tenants/:tenantId",
      { preHandler: requireScope("iam:delegate") },
      async (req, reply) => {
        const token = req.token;
        if (!token?.subject || !token.orgId) {
          return reply.code(401).send({ error: "unauthenticated" });
        }
        const eff = await deps.iam.effectiveRoles(
          token.subject,
          token.orgId,
          req.params.tenantId
        );
        if (eff.size === 0) {
          return reply.code(403).send({
            error: "cannot_delegate",
            reason: "caller has no authority over the tenant",
          });
        }
        const ok = await deps.orgAuthz.revoke(
          req.params.orgId,
          req.params.tenantId
        );
        if (!ok) return reply.code(404).send({ error: "not_found" });
        return reply.code(204).send();
      }
    );
  };
