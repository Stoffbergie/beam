import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { cloudflare } from "@cloudflare/vite-plugin";
import { createServer } from "vite-plus";
import type { TestProject } from "vite-plus/test/node";

declare module "vite-plus/test" {
  export interface ProvidedContext {
    baseUrl: string;
    tunnelDomain: string;
    ownerToken: string;
    cli: string;
  }
}

const tunnelDomain = "beam.test";
const ownerToken = "test-owner-token";

export default async function startWorker(project: TestProject): Promise<() => Promise<void>> {
  execFileSync("cargo", ["build", "--quiet", "--manifest-path", "cli/Cargo.toml"], { stdio: "inherit" });
  const server = await createServer({
    configFile: false,
    logLevel: "error",
    plugins: [cloudflare({ persistState: false, config: { vars: { TUNNEL_DOMAIN: tunnelDomain, BEAM_TOKEN: ownerToken } } })],
    server: { host: "127.0.0.1", port: 0, allowedHosts: true }
  });
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo;
  project.provide("baseUrl", `http://127.0.0.1:${address.port}`);
  project.provide("tunnelDomain", tunnelDomain);
  project.provide("ownerToken", ownerToken);
  project.provide("cli", `${process.cwd()}/cli/target/debug/beam`);
  return () => server.close();
}
