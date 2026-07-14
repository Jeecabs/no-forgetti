export interface AgentEnvironment {
  PI_SUBAGENT_CHILD_AGENT?: string;
  PI_SUBAGENT_RUN_ID?: string;
}

/** Gang/pi-subagents mark every non-primary child with these variables. */
export function isNonPrimaryAgent(env: AgentEnvironment = process.env): boolean {
  return Boolean(env.PI_SUBAGENT_CHILD_AGENT?.trim() || env.PI_SUBAGENT_RUN_ID?.trim());
}
