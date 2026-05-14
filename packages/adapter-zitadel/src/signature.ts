import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a `ZITADEL-Signature` header against the raw request body.
 *
 * Header format (as emitted by Zitadel — see `pkg/actions/signing.go`):
 *
 *   ZITADEL-Signature: t=<unix-seconds>,v1=<hex>(,v1=<hex>)*
 *
 * The signed string is `${unix-seconds}.${raw-body}`, HMAC-SHA256, with the
 * Target's signing key (returned at Target creation). Multiple `v1=`
 * signatures are accepted — Zitadel sends one per provided signing key so
 * keys can be rotated without downtime.
 */
export interface VerifyOptions {
  signingKeys: string[];
  toleranceSeconds?: number;        // default 300
  now?: () => number;               // injectable for tests (unix seconds)
}

export function verifyZitadelSignature(
  rawBody: string,
  header: string | undefined,
  opts: VerifyOptions
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing_header" };
  if (opts.signingKeys.length === 0) {
    return { ok: false, reason: "no_signing_keys_configured" };
  }
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now?.() ?? Math.floor(Date.now() / 1000);

  const parsed = parseHeader(header);
  if (!parsed) return { ok: false, reason: "invalid_header" };
  if (parsed.signatures.length === 0) {
    return { ok: false, reason: "no_signatures" };
  }
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }

  const signedPayload = Buffer.from(`${parsed.timestamp}.${rawBody}`, "utf8");
  for (const key of opts.signingKeys) {
    const expected = createHmac("sha256", key).update(signedPayload).digest();
    for (const sig of parsed.signatures) {
      if (sig.length === expected.length && timingSafeEqual(sig, expected)) {
        return { ok: true };
      }
    }
  }
  return { ok: false, reason: "no_match" };
}

interface ParsedHeader {
  timestamp: number;
  signatures: Buffer[];
}

function parseHeader(header: string): ParsedHeader | null {
  const out: ParsedHeader = { timestamp: 0, signatures: [] };
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") {
      const ts = Number.parseInt(v, 10);
      if (!Number.isFinite(ts)) return null;
      out.timestamp = ts;
    } else if (k === "v1") {
      if (!/^[0-9a-f]+$/i.test(v) || v.length % 2 !== 0) continue;
      out.signatures.push(Buffer.from(v, "hex"));
    }
  }
  if (out.timestamp === 0) return null;
  return out;
}
