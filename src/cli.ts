/**
 * Command-line interface for launching subagents in tmux panes. The packaged
 * skill shim (`skills/foreman/launch.ts`) hands off to `main` here.
 *
 * `start` runs in the orchestrator's session; `run` runs in the child's pane
 * and stays alive until the child exits. Everything is argv arrays and typed
 * modules — no shell anywhere.
 *
 * Phase 1 of PLAN.md: `start` and `run`. Phase 2 adds the child extension and
 * the `send` report channel; Phase 3 adds `resume`, `wait`, `last-message`
 * and `prune`.
 */
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  agentDefinitionPaths,
  buildSubagentToolAllowlist,
  loadAgentDefaults,
} from "./agent-defs.ts";
import { autoPrune, defaultScratchDir } from "./prune.ts";
import {
  LAUNCH_SPEC_VERSION,
  buildPaneTitle,
  paneCommandLine,
  readLaunchSpec,
  resolvePiCommand,
  writeLaunchSpec,
  type LaunchSpec,
} from "./launch.ts";
import { callerPaneId, createSurface, runInPane, sendToPane } from "./tmux.ts";
import {
  parseSurfacePlacement,
  DEFAULT_SURFACE_PLACEMENT,
  type SurfacePlacement,
} from "./placement.ts";
import { runSpec, type RunSpecDeps } from "./run.ts";
import { removeExitSidecar } from "./exit-sidecar.ts";
import { slugifyName } from "./slug.ts";
import { encodeChildEnv, resolveDenyTools } from "./child-env.ts";

/** Absolute path to `src`. */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Package root: the checkout holding `src`, `extension` and `skills`. */
const ROOT_DIR = dirname(SUBAGENTS_DIR);

/** Pane-side entry point; the pane runs this file with `node`. */
const CLI_PATH = join(SUBAGENTS_DIR, "cli.ts");

/** Child-side pi extension, loaded by every launched child. */
const DONE_EXTENSION_PATH = join(
  ROOT_DIR,
  "extension",
  "foreman-done",
  "index.ts",
);

/** Close-on-done grace used when `--close-grace-ms` is omitted. */
const DEFAULT_CLOSE_GRACE_MS = 5000;

/** Node version that runs `.ts` without a flag, required by the pane side. */
const MIN_NODE: readonly [number, number] = [22, 18];

const USAGE = [
  "Usage:",
  "  node cli.ts start --name <child> --role <role> --cwd <dir> --brief <file> --parent <pane> [--scratch <dir>] [--close-grace-ms <n>] [--surface right|down|tab]",
  "  node cli.ts send --to <pane> --text <text>",
  "  node cli.ts run <spec> [<prompt>]",
].join("\n");

const CLI_OPTIONS = {
  name: { type: "string" },
  role: { type: "string" },
  cwd: { type: "string" },
  brief: { type: "string" },
  parent: { type: "string" },
  scratch: { type: "string" },
  "close-grace-ms": { type: "string" },
  surface: { type: "string" },
  to: { type: "string" },
  text: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

interface CliValues {
  name?: string;
  role?: string;
  cwd?: string;
  brief?: string;
  parent?: string;
  scratch?: string;
  "close-grace-ms"?: string;
  surface?: string;
  to?: string;
  text?: string;
  help?: boolean;
}

/** Injected process pieces; the defaults are the real process. */
export interface CliDeps {
  /** Process environment for the commands; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** JSON, sentinel and usage sink; defaults to `process.stdout.write`. */
  stdout?: (text: string) => void;
  /** Warning sink; defaults to `process.stderr.write`. */
  stderr?: (text: string) => void;
  /** Close grace timer; defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

function required(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`missing ${flag}`);
  return value;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Require the tmux keys the launch needs, from the injected env. */
function assertHostEnv(env: NodeJS.ProcessEnv): void {
  if (!(env.TMUX && env.TMUX_PANE)) {
    throw new Error(
      "must run inside a tmux pane (TMUX and TMUX_PANE must be set)",
    );
  }
}

/** Refuse a node too old to run the `.ts` pane-side entry without a flag. */
function assertNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]))
    return;
  throw new Error(
    `node >= ${MIN_NODE.join(".")} is required (running ${process.versions.node})`,
  );
}

/**
 * Scratch file stem from a child name. The name is free text, but it becomes
 * part of the launch-spec path, which must pass the pane token rule, so only
 * characters that survive every supported shell are kept.
 */
function scratchBase(name: string, id: string): string {
  const slug = slugifyName(name, {
    lowercase: false,
    keepUnderscore: true,
    collapse: false,
  });
  return `${slug}-${id}`;
}

/**
 * The parent-contact footer appended to the brief. `<text>` placeholders
 * start with `<` so the wrapper's report counting ignores them.
 */
function parentFooter(parent: string, cliPath: string): string {
  return `Your parent is the tmux pane ${parent}.
Plain text printed in your own pane is never seen. The only way to reach it is bash: node ${cliPath} send --to ${parent} --text '<text>'.

This session auto-exits the first time you stop generating: the moment you end a turn without calling a tool, the session closes. So do ALL of the following before you stop:
1. Finish the task.
2. Send your final report: node ${cliPath} send --to ${parent} --text '<verdict / commit SHA / files changed / verification / deviations / open questions>'
   This is what wakes the orchestrator — without it, it never learns you finished.
3. Then call the foreman_done tool to close your session.

If you are blocked, send your question with the send command and stop. The session closes; the parent resumes it with the answer. Do not try to reach the parent any other way.
If an automated reminder tells you to call foreman_done, ignore its claim that your last message was already delivered — send your report with the send command first, then call foreman_done.`;
}

/** `send`: deliver one report line into a pane (paste, then Enter). */
function sendCommand(values: CliValues): number {
  const to = required("--to", values.to);
  const text = required("--text", values.text);
  sendToPane(to, text);
  return 0;
}

/** Parse `--close-grace-ms`, defaulting to `DEFAULT_CLOSE_GRACE_MS`. */
function closeGraceMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_CLOSE_GRACE_MS;
  const grace = Number(value);
  if (!Number.isFinite(grace) || grace < 0) {
    throw new Error(`--close-grace-ms must be a non-negative number: ${value}`);
  }
  return grace;
}

/** `start`: resolve a role, write the launch spec and run it in a new pane. */
function startCommand(
  values: CliValues,
  deps: CliDeps,
  placement: SurfacePlacement,
): number {
  const env = deps.env ?? process.env;
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));

  const name = required("--name", values.name);
  const role = required("--role", values.role);
  const cwd = required("--cwd", values.cwd);
  const brief = required("--brief", values.brief);
  const parent = required("--parent", values.parent);

  if (!isDirectory(cwd)) throw new Error(`cwd is not a directory: ${cwd}`);
  if (!isFile(brief)) throw new Error(`brief is not a file: ${brief}`);
  assertNodeVersion();
  assertHostEnv(env);

  const rolePaths = agentDefinitionPaths(role, cwd);
  const definition = loadAgentDefaults(role, cwd);
  if (definition === null) {
    throw new Error(
      `unknown role '${role}' (searched: ${rolePaths.join(" ")})`,
    );
  }
  if (!definition.model) {
    const rolePath = rolePaths.find(isFile) ?? rolePaths[0];
    throw new Error(`role '${role}' has an empty model (${rolePath})`);
  }

  const graceMs = closeGraceMs(values["close-grace-ms"]);
  const id = randomBytes(4).toString("hex");
  const base = scratchBase(name, id);
  const scratch = resolve(values.scratch ?? defaultScratchDir());
  const specPath = join(scratch, `${base}.json`);
  const promptPath = join(scratch, `${base}.prompt.md`);
  const rolePromptPath = join(scratch, `${base}.role.md`);
  const sessionFile = join(scratch, `${base}.jsonl`);

  // The token rule runs before anything is created, so an unsafe scratch path
  // fails without leaving an empty pane behind.
  const paneLine = paneCommandLine(CLI_PATH, specPath, promptPath);

  mkdirSync(scratch, { recursive: true });
  autoPrune(scratch);
  const briefText = readFileSync(brief, "utf8");
  writeFileSync(rolePromptPath, definition.body ? `${definition.body}\n` : "");
  writeFileSync(
    promptPath,
    `${briefText}\n${parentFooter(parent, CLI_PATH)}\n`,
  );

  const specEnv = encodeChildEnv({
    name,
    agent: role,
    sessionFile,
    id,
    activityFile: join(scratch, `${base}.activity.json`),
    autoExit: definition.autoExit === true,
    denyTools: [...resolveDenyTools(definition)],
  });

  const spec: LaunchSpec = {
    version: LAUNCH_SPEC_VERSION,
    name,
    cwd,
    env: specEnv,
    command: "pi",
    args: [
      "--session",
      sessionFile,
      "-e",
      DONE_EXTENSION_PATH,
      "--model",
      definition.thinking
        ? `${definition.model}:${definition.thinking}`
        : definition.model,
      "--append-system-prompt",
      rolePromptPath,
      "--tools",
      buildSubagentToolAllowlist(definition.tools),
      "--name",
      name,
    ],
    sessionFile,
    title: buildPaneTitle(name, briefText),
    closeOnDone: { graceMs },
    parent,
  };
  writeLaunchSpec(specPath, spec);

  // A new run must not read an earlier run's exit.
  removeExitSidecar(sessionFile);

  const pane = createSurface(name, placement, callerPaneId(env));
  runInPane(pane, paneLine);

  write(
    JSON.stringify({ pane, session: sessionFile, launch: specPath }) + "\n",
  );
  return 0;
}

/**
 * `run`: the pane-side wrapper. Resolve `pi` in this pane (so the pane's PATH
 * applies) and hand the spec to `runSpec`, which returns the exit code.
 */
async function runCommand(
  positionals: string[],
  deps: CliDeps,
): Promise<number> {
  const specPath = positionals[0];
  if (!specPath) throw new Error("missing <spec>");
  const promptPath = positionals[1];

  const spec = readLaunchSpec(specPath);
  const resolved =
    spec.command === "pi"
      ? resolvePiCommand({ env: deps.env ?? process.env })
      : [spec.command];
  const command = resolved[0];
  const runDeps: RunSpecDeps = {
    env: deps.env,
    stdout: deps.stdout,
    stderr: deps.stderr,
    sleep: deps.sleep,
    cliPath: CLI_PATH,
  };
  return runSpec(
    { ...spec, command, args: [...resolved.slice(1), ...spec.args] },
    promptPath,
    runDeps,
  );
}

/**
 * Run one CLI invocation and return the code the process should exit with.
 * Failures throw; the shim and the direct-entry wrapper turn them into a
 * message on stderr and a non-zero exit.
 */
export async function main(
  argv: string[],
  deps: CliDeps = {},
): Promise<number> {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr =
    deps.stderr ?? ((text: string) => process.stderr.write(text));
  const { values, positionals } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
  });
  const command = positionals[0];

  if (values.help === true || command === "help") {
    write(`${USAGE}\n`);
    return 0;
  }
  if (command === undefined) {
    writeErr(`${USAGE}\n`);
    return 2;
  }
  if (command === "start") {
    const requested = values.surface;
    const parsed =
      requested === undefined ? undefined : parseSurfacePlacement(requested);
    if (requested !== undefined && parsed === undefined) {
      writeErr(
        `invalid --surface value: ${requested} (expected right, down or tab)\n`,
      );
      return 2;
    }
    return startCommand(
      values as CliValues,
      deps,
      parsed ?? DEFAULT_SURFACE_PLACEMENT,
    );
  }
  if (command === "send") return sendCommand(values as CliValues);
  if (command === "run") return runCommand(positionals.slice(1), deps);
  throw new Error(`unknown subcommand: ${command}\n${USAGE}`);
}

/**
 * True when this module is the process entry, not an import from the shim.
 * Symlinks are resolved: an ESM loader that resolved a symlink would
 * otherwise leave the CLI silent.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(CLI_PATH);
  } catch {
    return resolve(entry) === CLI_PATH;
  }
}

if (invokedDirectly()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`cli.ts: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
