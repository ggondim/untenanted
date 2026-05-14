import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { DecodedToken } from "./jwt-verifier.js";

/**
 * Returns a Fastify preHandler that ensures the platform/tenant token attached
 * to the request carries the required scope. Looks up `request.token` (set by
 * the tenancy middleware). Responds 403 `insufficient_scope` otherwise.
 */
export function requireScope(scope: string): preHandlerHookHandler {
  return async function scopeGuard(
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const token = (req as unknown as { token?: DecodedToken }).token;
    if (!token) {
      void reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    if (!token.scopes.has(scope)) {
      void reply.code(403).send({
        error: "insufficient_scope",
        required_scope: scope,
      });
      return;
    }
  };
}

/**
 * Variant requiring every scope in the list.
 */
export function requireAllScopes(scopes: string[]): preHandlerHookHandler {
  return async function allScopesGuard(
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const token = (req as unknown as { token?: DecodedToken }).token;
    if (!token) {
      void reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    const missing = scopes.filter((s) => !token.scopes.has(s));
    if (missing.length > 0) {
      void reply.code(403).send({
        error: "insufficient_scope",
        required_scopes: scopes,
        missing,
      });
    }
  };
}
