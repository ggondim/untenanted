/**
 * Example: consume the API as an end-user with a platform access token.
 *
 *   pnpm tsx examples/sdk-usage/list-my-tenants.ts \
 *     --base http://localhost:3000 --token "$PLATFORM_TOKEN"
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
  if (!token) throw new Error("--token is required");

  const client = new UntenantedClient({
    baseUrl,
    getToken: () => token,
  });

  const { tenants } = await client.iam.listMyTenants();
  console.log(JSON.stringify(tenants, null, 2));
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
