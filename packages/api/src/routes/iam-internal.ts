import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ValidateExchangeRequest } from "@untenanted/types";
import { requireSharedSecret } from "@untenanted/middleware";
import type { IamService } from "../services/iam.js";

export interface IamInternalDeps {
  iam: IamService;
  sharedSecret: string;
  headerName?: string;
}

const ListUserTenantsBody = z.object({
  userId: z.string().min(1),
  orgId: z.string().min(1),
});

export const iamInternalRoutes =
  (deps: IamInternalDeps): FastifyPluginAsync =>
  async (app: FastifyInstance) => {
    const headerName = deps.headerName ?? "x-internal-auth";

    app.addHook("preHandler", requireSharedSecret(deps.sharedSecret, headerName));

    app.post("/iam/internal/list-user-tenants", async (req, reply) => {
      const parsed = ListUserTenantsBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          details: parsed.error.flatten(),
        });
      }
      const tenants = await deps.iam.listUserTenants(
        parsed.data.userId,
        parsed.data.orgId
      );
      return { tenants };
    });

    app.post("/iam/internal/validate-exchange", async (req, reply) => {
      const parsed = ValidateExchangeRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          details: parsed.error.flatten(),
        });
      }
      const { userId, orgId, requestedTids, requestedScopes } = parsed.data;
      const result = await deps.iam.validateExchange(
        userId,
        orgId,
        requestedTids,
        requestedScopes
      );
      return result;
    });
  };
