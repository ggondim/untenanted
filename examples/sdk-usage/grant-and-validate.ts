/**
 * Example: as a delegating admin, grant an org access to a tenant, then have
 * the (simulated) IdP adapter call /iam/internal/validate-exchange to confirm
 * a user from that org could request the corresponding scope.
 *
 *   pnpm tsx examples/sdk-usage/grant-and-validate.ts \
 *     --base http://localhost:3000 \
 *     --token "$ADMIN_PLATFORM_TOKEN" \
 *     --internal-secret "$INTERNAL_AUTH_SECRET"
 */
import { UntenantedClient } from "@untenanted/sdk";

function arg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0) return process.argv[i + 1];
  return fallback;
}

async function main(): Promise<void> {
  const baseUrl = arg("base", "http://localhost:3000")!;
  const token = arg("token");
  const internalSecret = arg("internal-secret");
  if (!token) throw new Error("--token is required");
  if (!internalSecret) throw new Error("--internal-secret is required");

  const client = new UntenantedClient({ baseUrl, getToken: () => token });

  // 1. Create a tenant (requires iam:tenant:create scope on the admin token).
  const tenant = await client.tenants.create({
    id: "demo-tenant",
    name: "Demo tenant",
  });
  console.log("created tenant:", tenant.id);

  // 2. Grant org-to-tenant access (requires iam:delegate + caller possesses roles).
  await client.iam.grantOrgAccess("demo-org", tenant.id, {
    roles: ["campaign:read", "campaign:write"],
  });

  // 3. Simulate the IdP adapter validating an exchange for some user in that org.
  const result = await client.internal.validateExchange(
    {
      userId: "alice",
      orgId: "demo-org",
      requestedTids: [tenant.id],
      requestedScopes: ["campaign:read"],
    },
    internalSecret
  );
  console.log("validate-exchange:", result);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
