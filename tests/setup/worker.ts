import { execFileSync } from "node:child_process";
import { createTestHarness } from "wrangler";
import type { TestProject } from "vite-plus/test/node";

declare module "vite-plus/test" {
  export interface ProvidedContext {
    baseUrl: string;
    tunnelDomain: string;
    cli: string;
  }
}

const tunnelDomain = "beam.test";

export default async function startWorker(project: TestProject): Promise<() => Promise<void>> {
  execFileSync("cargo", ["build", "--quiet", "--manifest-path", "cli/Cargo.toml"], { stdio: "inherit" });
  const server = createTestHarness({ workers: [{ configPath: "wrangler.toml", vars: { TUNNEL_DOMAIN: tunnelDomain } }] });
  const { url } = await server.listen();
  project.provide("baseUrl", url.origin);
  project.provide("tunnelDomain", tunnelDomain);
  project.provide("cli", `${process.cwd()}/cli/target/debug/beam`);
  return () => server.close();
}
