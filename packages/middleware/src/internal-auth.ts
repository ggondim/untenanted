import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time shared-secret check used by internal endpoints
 * (`/iam/internal/validate-exchange`, `/webhooks/events`).
 *
 * Caller provides the expected secret and the header name. The middleware
 * compares with `crypto.timingSafeEqual`.
 */
export function requireSharedSecret(
  expected: string,
  headerName: string
): preHandlerHookHandler {
  const expectedBuf = Buffer.from(expected, "utf8");
  const header = headerName.toLowerCase();
  return async function sharedSecretGuard(
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const got = req.headers[header];
    const provided = typeof got === "string" ? got : Array.isArray(got) ? got[0] : undefined;
    if (!provided) {
      void reply.code(401).send({ error: "missing_credentials" });
      return;
    }
    const providedBuf = Buffer.from(provided, "utf8");
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      void reply.code(401).send({ error: "invalid_credentials" });
    }
  };
}
