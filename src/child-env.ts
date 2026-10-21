import type { AgentDefaults } from "./agent-defs.ts";

/**
 * The parent/child env contract. Producers write it with `encodeChildEnv`,
 * child-side readers parse it with `decodeChildEnv`.
 */
export interface ChildEnv {
  name?: string;
  agent?: string;
  sessionFile?: string;
  id?: string;
  activityFile?: string;
  surface?: string;
  autoExit: boolean;
  denyTools: string[];
}

/** Encode the child env. Writes only fields that are set. */
export function encodeChildEnv(env: ChildEnv): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.name !== undefined) out.PI_FOREMAN_NAME = env.name;
  if (env.agent !== undefined) out.PI_FOREMAN_AGENT = env.agent;
  if (env.sessionFile !== undefined) out.PI_FOREMAN_SESSION = env.sessionFile;
  if (env.id !== undefined) out.PI_FOREMAN_ID = env.id;
  if (env.activityFile !== undefined)
    out.PI_FOREMAN_ACTIVITY_FILE = env.activityFile;
  if (env.surface !== undefined) out.PI_FOREMAN_SURFACE = env.surface;
  if (env.autoExit) out.PI_FOREMAN_AUTO_EXIT = "1";
  if (env.denyTools.length > 0) out.PI_DENY_TOOLS = env.denyTools.join(",");
  return out;
}

/** Split a comma-separated tool list, trimming entries and dropping empties. */
function parseToolList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/** Decode the child env. An empty string counts as not set. */
export function decodeChildEnv(env: NodeJS.ProcessEnv): ChildEnv {
  const value = (key: string): string | undefined => {
    const raw = env[key];
    return raw ? raw : undefined;
  };

  return {
    name: value("PI_FOREMAN_NAME"),
    agent: value("PI_FOREMAN_AGENT"),
    sessionFile: value("PI_FOREMAN_SESSION"),
    id: value("PI_FOREMAN_ID"),
    activityFile: value("PI_FOREMAN_ACTIVITY_FILE"),
    surface: value("PI_FOREMAN_SURFACE"),
    autoExit: env.PI_FOREMAN_AUTO_EXIT === "1",
    denyTools: parseToolList(env.PI_DENY_TOOLS),
  };
}

/** True when this env belongs to a subagent child (it carries a session file). */
export function isSubagentChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return decodeChildEnv(env).sessionFile !== undefined;
}

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * foreman children cannot spawn (there are no spawn tools to deny), so only
 * an explicit `deny-tools` frontmatter line contributes.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;
  for (const t of parseToolList(agentDefs.denyTools)) denied.add(t);
  return denied;
}
