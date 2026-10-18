import type { Beam } from "./beam";

export type Env = {
  BEAMS: DurableObjectNamespace<Beam>;
  TUNNEL_DOMAIN: string;
  BEAM_TOKEN?: string;
};
