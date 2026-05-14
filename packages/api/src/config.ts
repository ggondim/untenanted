import { z } from "zod";

const Bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : /^(1|true|yes|on)$/i.test(v)));

const ConfigSchema = z.object({
  HTTP_PORT: z.coerce.number().int().default(3000),
  HTTP_HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  AUTO_MIGRATE: Bool.default(true),

  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_NAME: z.string().default("untenanted"),
  DB_USER: z.string().default("untenanted"),
  DB_PASSWORD: z.string().default("untenanted"),
  DB_SSL: z
    .enum(["disable", "require", "verify-full"])
    .default("disable"),
  DB_POOL_MAX: z.coerce.number().int().default(10),

  IDP_JWKS_URI: z.string().url(),
  IDP_ISSUER: z.string().min(1),
  IDP_AUDIENCE: z.string().min(1),
  IDP_TOKEN_ENDPOINT: z.string().url(),
  IDP_CLIENT_ID: z.string().min(1),
  IDP_CLIENT_SECRET: z.string().optional(),

  CLAIM_ORG_ID: z.string().default("org_id"),
  CLAIM_TIDS: z.string().default("tids"),
  CLAIM_SCOPE: z.string().default("scope"),
  CLAIM_SUBJECT: z.string().default("sub"),

  INTERNAL_AUTH_SECRET: z.string().min(8),
  WEBHOOK_AUTH_SECRET: z.string().min(8),

  // Optional pluggable IdP adapters. Comma-separated list of names; each name
  // enables a matching @untenanted/adapter-* plugin. Default: none.
  IDP_ADAPTERS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
    ),

  // Per-adapter settings. Read only when the corresponding name is in
  // IDP_ADAPTERS — kept optional so unused adapters don't require values.
  ADAPTER_ZITADEL_SIGNING_KEYS: z
    .string()
    .optional()
    .transform((s) =>
      (s ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    ),
  ADAPTER_ZITADEL_TIDS_CLAIM: z.string().optional(),
  ADAPTER_ZITADEL_ORG_CLAIM: z.string().optional(),
  ADAPTER_ZITADEL_ROUTE_PREFIX: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }
  return parsed.data;
}
