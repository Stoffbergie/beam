import type { Beam } from "./beam";

export type Env = {
  BEAMS: DurableObjectNamespace<Beam>;
  CREATES: RateLimit;
  LOOKUPS: RateLimit;
  TUNNEL_DOMAIN: string;
  BEAM_TOKEN?: string;
};
