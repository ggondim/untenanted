import {
  createRemoteJWKSet,
  jwtVerify,
  errors as joseErrors,
  type JWTPayload,
  type JWTVerifyResult,
} from "jose";
import {
  type ClaimNames,
  mergeClaimNames,
} from "./claim-names.js";

export interface JwtVerifierOptions {
  jwksUri: string;
  issuer: string;
  audience: string | string[];
  /** Override claim names if the IdP uses a different vocabulary. */
  claimNames?: Partial<ClaimNames>;
  /** Allow tokens whose `exp` is in the past — used by the tenancy middleware. */
  allowExpired?: boolean;
  /** Tolerance in seconds for `iat`/`nbf`/`exp` checks. Default 0. */
  clockTolerance?: number;
}

export interface DecodedToken {
  raw: string;
  payload: JWTPayload;
  /** Convenience accessors using the configured claim names. */
  subject: string | undefined;
  orgId: string | undefined;
  tids: string[];
  scopes: Set<string>;
  isExpired: boolean;
}

export class JwtVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  readonly claimNames: ClaimNames;

  constructor(private readonly opts: JwtVerifierOptions) {
    this.jwks = createRemoteJWKSet(new URL(opts.jwksUri));
    this.claimNames = mergeClaimNames(opts.claimNames);
  }

  /**
   * Verify a JWT. When `allowExpired` is true on the verifier OR `expired` is
   * true on a per-call basis, an expired token still returns its payload with
   * `isExpired = true` — signature must still be valid.
   */
  async verify(
    raw: string,
    perCall: { allowExpired?: boolean } = {}
  ): Promise<DecodedToken> {
    const allowExpired = perCall.allowExpired ?? this.opts.allowExpired ?? false;
    let result: JWTVerifyResult;
    let isExpired = false;

    try {
      result = await jwtVerify(raw, this.jwks, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        clockTolerance: this.opts.clockTolerance ?? 0,
      });
    } catch (e) {
      if (
        allowExpired &&
        e instanceof joseErrors.JWTExpired &&
        e.payload != null
      ) {
        // Signature was valid; expiry alone failed. Trust the payload.
        result = { payload: e.payload, protectedHeader: {} as never };
        isExpired = true;
      } else {
        throw e;
      }
    }

    const payload = result.payload;
    return {
      raw,
      payload,
      subject: getString(payload, this.claimNames.subject),
      orgId: getString(payload, this.claimNames.orgId),
      tids: getStringArray(payload, this.claimNames.tids),
      scopes: parseScope(getString(payload, this.claimNames.scope)),
      isExpired,
    };
  }
}

function getString(payload: JWTPayload, key: string): string | undefined {
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function getStringArray(payload: JWTPayload, key: string): string[] {
  const v = (payload as Record<string, unknown>)[key];
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  if (typeof v === "string" && v.length > 0) {
    return v.split(/\s+/);
  }
  return [];
}

function parseScope(scope: string | undefined): Set<string> {
  if (!scope) return new Set();
  return new Set(scope.split(/\s+/).filter(Boolean));
}

export { joseErrors };
