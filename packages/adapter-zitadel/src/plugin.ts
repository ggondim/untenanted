import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { verifyZitadelSignature } from "./signature.js";
import type {
  IamLookupForAdapter,
  ZitadelEventPayload,
  ZitadelPreAccessTokenPayload,
  ZitadelPreAccessTokenResponse,
} from "./types.js";

export interface ZitadelAdapterOptions {
  iam: IamLookupForAdapter;

  /**
   * One or more signing keys for the Zitadel Targets pointing at this adapter.
   * Each Target gets its own key on creation — list all so any of them is
   * accepted. If empty, signature verification is DISABLED (suitable only for
   * fully-isolated dev networks; logs a warning at boot).
   */
  signingKeys: string[];

  /** Tolerance for the Zitadel timestamp (default: 300 seconds). */
  toleranceSeconds?: number;

  /**
   * Custom claim keys to emit in `append_claims`. Match the host application's
   * configured claim names so the JWT verifier downstream finds them.
   */
  orgClaim?: string;  // default "urn:untenanted:org_id"
  tidsClaim?: string; // default "urn:untenanted:tids"

  /** URL prefix for the adapter routes. Default: "/adapters/zitadel". */
  routePrefix?: string;
}

const PREACCESSTOKEN_PATH = "preaccesstoken";
const EVENTS_PATH = "events";

export function createZitadelAdapter(
  opts: ZitadelAdapterOptions
): FastifyPluginAsync {
  const orgClaim = opts.orgClaim ?? "urn:untenanted:org_id";
  const tidsClaim = opts.tidsClaim ?? "urn:untenanted:tids";
  const prefix = (opts.routePrefix ?? "/adapters/zitadel").replace(/\/$/, "");
  const tolerance = opts.toleranceSeconds ?? 300;
  const verifySig = opts.signingKeys.length > 0;

  return async function zitadelAdapter(app: FastifyInstance) {
    if (!verifySig) {
      app.log.warn(
        { adapter: "zitadel" },
        "no signing keys configured — adapter accepts unsigned requests; only do this on isolated dev networks"
      );
    }

    // Capture the raw body for HMAC verification BEFORE Fastify parses JSON.
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          done(null, body ? JSON.parse(String(body)) : {});
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );
    app.addHook("preValidation", async (req: FastifyRequest) => {
      // Stash the raw body string for the signature check.
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
      (req as unknown as { rawBody?: string }).rawBody = rawBody;
    });

    const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
      if (!verifySig) return true;
      const header = req.headers["zitadel-signature"];
      const headerStr = Array.isArray(header) ? header[0] : header;
      const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? "";
      const result = verifyZitadelSignature(rawBody, headerStr, {
        signingKeys: opts.signingKeys,
        toleranceSeconds: tolerance,
      });
      if (!result.ok) {
        void reply.code(401).send({
          error: "invalid_signature",
          reason: result.reason,
        });
        return false;
      }
      return true;
    };

    app.post(`${prefix}/${PREACCESSTOKEN_PATH}`, async (req, reply) => {
      if (!(await guard(req, reply))) return reply;
      const body = (req.body ?? {}) as ZitadelPreAccessTokenPayload;
      const userId = body.user?.id;
      const orgId = body.org?.id;
      if (!userId || !orgId) {
        const out: ZitadelPreAccessTokenResponse = { append_claims: [] };
        return out;
      }
      const tenants = await opts.iam.listUserTenants(userId, orgId);
      const tids = tenants.map((t) => t.tenantId);

      // Effective scope = intersection of roles across all accessible tids
      // (spec §10 invariant: every scope holds in every tid in the token).
      let scopeSet: Set<string> | null = null;
      for (const t of tenants) {
        const rs = new Set(t.effectiveRoles);
        if (scopeSet === null) scopeSet = rs;
        else for (const x of [...scopeSet]) if (!rs.has(x)) scopeSet.delete(x);
      }
      const scope = scopeSet ? [...scopeSet] : [];

      const claims: ZitadelPreAccessTokenResponse["append_claims"] = [
        { key: orgClaim, value: orgId },
      ];
      if (tids.length > 0) claims!.push({ key: tidsClaim, value: tids });
      if (scope.length > 0) claims!.push({ key: "scope", value: scope.join(" ") });
      const out: ZitadelPreAccessTokenResponse = { append_claims: claims };
      return out;
    });

    app.post(`${prefix}/${EVENTS_PATH}`, async (req, reply) => {
      if (!(await guard(req, reply))) return reply;
      const body = (req.body ?? {}) as ZitadelEventPayload;
      const eventType = body.event_type ?? body.eventType ?? "";
      const aggregate = body.aggregateID ?? body.aggregateId ?? "";

      if (!aggregate) return { ignored: true, reason: "no_aggregate_id" };

      if (eventType.startsWith("user.") && /removed|deleted/.test(eventType)) {
        const affected = await opts.iam.deleteAllUserAuthz(aggregate);
        return { forwarded: "user.removed", affected };
      }
      if (eventType.startsWith("org.") && /removed|deleted/.test(eventType)) {
        const affected = await opts.iam.deleteAllOrgAuthz(aggregate);
        return { forwarded: "org.removed", affected };
      }
      return { ignored: true, eventType };
    });
  };
}
