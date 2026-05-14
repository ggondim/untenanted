export interface ClaimNames {
  /** Claim that carries the user's organization id. Default: "org_id". */
  orgId: string;
  /** Claim that carries the list of tenant ids in the token. Default: "tids". */
  tids: string;
  /** Claim that carries the space-separated OAuth2 scope. Default: "scope". */
  scope: string;
  /** Claim that carries the subject (user id). Default: "sub". */
  subject: string;
}

export const DEFAULT_CLAIM_NAMES: ClaimNames = {
  orgId: "org_id",
  tids: "tids",
  scope: "scope",
  subject: "sub",
};

export function mergeClaimNames(
  overrides?: Partial<ClaimNames>
): ClaimNames {
  return { ...DEFAULT_CLAIM_NAMES, ...(overrides ?? {}) };
}
