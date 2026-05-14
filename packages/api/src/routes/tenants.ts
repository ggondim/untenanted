import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  CreateTenantRequest,
  UpdateTenantRequest,
  ListTenantsQuery,
} from "@untenanted/types";
import type { TenantRepository } from "../repos/tenant.js";
import { requireScope } from "@untenanted/middleware";

export interface TenantsRouteDeps {
  tenants: TenantRepository;
}

export const tenantsRoutes =
  (deps: TenantsRouteDeps): FastifyPluginAsync =>
  async (app: FastifyInstance) => {
    app.get("/tenants", async (req, reply) => {
      const parsed = ListTenantsQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_query",
          details: parsed.error.flatten(),
        });
      }
      const out = await deps.tenants.list(parsed.data);
      return out;
    });

    app.get<{ Params: { id: string } }>("/tenants/:id", async (req, reply) => {
      const t = await deps.tenants.findById(req.params.id);
      if (!t) return reply.code(404).send({ error: "not_found" });
      return t;
    });

    app.post(
      "/tenants",
      { preHandler: requireScope("iam:tenant:create") },
      async (req, reply) => {
        const parsed = CreateTenantRequest.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: "invalid_body",
            details: parsed.error.flatten(),
          });
        }
        try {
          const t = await deps.tenants.create(parsed.data);
          return reply.code(201).send(t);
        } catch (e) {
          const msg = (e as Error).message;
          if (/duplicate|unique/i.test(msg)) {
            return reply.code(409).send({ error: "conflict" });
          }
          throw e;
        }
      }
    );

    app.patch<{ Params: { id: string } }>(
      "/tenants/:id",
      { preHandler: requireScope("iam:tenant:update") },
      async (req, reply) => {
        const parsed = UpdateTenantRequest.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: "invalid_body",
            details: parsed.error.flatten(),
          });
        }
        const t = await deps.tenants.update(req.params.id, parsed.data);
        if (!t) return reply.code(404).send({ error: "not_found" });
        return t;
      }
    );

    app.delete<{ Params: { id: string } }>(
      "/tenants/:id",
      { preHandler: requireScope("iam:tenant:delete") },
      async (req, reply) => {
        const ok = await deps.tenants.delete(req.params.id);
        if (!ok) return reply.code(404).send({ error: "not_found" });
        return reply.code(204).send();
      }
    );
  };
