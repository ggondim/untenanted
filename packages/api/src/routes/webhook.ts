import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { NormalizedWebhookEvent } from "@untenanted/types";
import { requireSharedSecret } from "@untenanted/middleware";
import type { UserAuthzRepository } from "../repos/user-authz.js";
import type { OrgAuthzRepository } from "../repos/org-authz.js";

export interface WebhookDeps {
  userAuthz: UserAuthzRepository;
  orgAuthz: OrgAuthzRepository;
  sharedSecret: string;
  headerName?: string;
}

export const webhookRoutes =
  (deps: WebhookDeps): FastifyPluginAsync =>
  async (app: FastifyInstance) => {
    const headerName = deps.headerName ?? "x-webhook-auth";

    app.addHook("preHandler", requireSharedSecret(deps.sharedSecret, headerName));

    app.post("/webhooks/events", async (req, reply) => {
      const parsed = NormalizedWebhookEvent.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_event",
          details: parsed.error.flatten(),
        });
      }
      const event = parsed.data;
      let affected = 0;
      switch (event.type) {
        case "user.removed":
          affected = await deps.userAuthz.deleteAllForUser(event.userId);
          break;
        case "org.removed":
          affected = await deps.orgAuthz.deleteAllForOrg(event.orgId);
          break;
      }
      return { ok: true, type: event.type, affected };
    });
  };
