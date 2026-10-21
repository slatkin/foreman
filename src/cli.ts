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
  existsSync,
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
import {
  autoPrune,
  defaultScratchDir,
  pruneScratch,
  DEFAULT_PRUNE_MAX_AGE_DAYS,
} from "./prune.ts";
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
import {
  exitSidecarPath,
  interpretExitSidecar,
  readExitSidecar,
  removeExitSidecar,
} from "./exit-sidecar.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";
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

/** Default `wait` timeout, in seconds. */
const DEFAULT_WAIT_TIMEOUT_S = 600;

/** Poll interval for the `wait` loop. */
const WAIT_POLL_MS = 500;

/** Node version that runs `.ts` without a flag, required by the pane side. */
const MIN_NODE: readonly [number, number] = [22, 18];

const USAGE = [
  "Usage:",
  "  node cli.ts start --name <child> --role <role> --cwd <dir> --brief <file> --parent <pane> [--scratch <dir>] [--close-grace-ms <n>] [--surface right|down|tab]",
  "  node cli.ts send --to <pane> --text <text>",
  "  node cli.ts run <spec> [<prompt>]",
  "  node cli.ts last-message --session <file>",
  "  node cli.ts wait --session <file> [--timeout <seconds>]",
  "  node cli.ts prune [--scratch <dir>] [--max-age-days <n>] [--dry-run]",
  "  node cli.ts resume --launch <spec> --prompt <file> [--name <child>] [--surface right|down|tab]",
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
  session: { type: "string" },
  launch: { type: "string" },
  prompt: { type: "string" },
  timeout: { type: "string" },
  "max-age-days": { type: "string" },
  "dry-run": { type: "boolean" },
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
  session?: string;
  launch?: string;
  prompt?: string;
  timeout?: string;
  "max-age-days"?: string;
  "dry-run"?: boolean;
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

/** `last-message`: print a session's last assistant message. */
function lastMessageCommand(values: CliValues, deps: CliDeps): number {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const sessionPath = required("--session", values.session);
  const text = findLastAssistantMessage(getNewEntries(sessionPath, 0));
  write(`${text ?? "(no assistant message)"}\n`);
  return 0;
}

/**
 * The `--surface` flag of the launching commands. A missing flag means the
 * default placement; an unknown value is a usage error (the caller exits 2
 * and the message goes to stderr).
 */
function surfacePlacement(
  values: CliValues,
  writeErr: (text: string) => void,
): SurfacePlacement | null {
  const requested = values.surface;
  if (requested === undefined) return DEFAULT_SURFACE_PLACEMENT;
  const parsed = parseSurfacePlacement(requested);
  if (parsed === undefined) {
    writeErr(
      `invalid --surface value: ${requested} (expected right, down or tab)\n`,
    );
    return null;
  }
  return parsed;
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
 * `resume`: run an existing launch spec in a new pane with a new prompt.
 *
 * The spec is reused unchanged, so the child resumes the same session and
 * keeps its close grace; only the prompt and the pane are new. The prompt
 * gets the parent-contact footer again — without it the resumed child has no
 * instruction to send its report, and the orchestrator never wakes.
 */
function resumeCommand(
  values: CliValues,
  deps: CliDeps,
  placement: SurfacePlacement,
): number {
  const env = deps.env ?? process.env;
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));

  const launchPath = required("--launch", values.launch);
  const promptPath = required("--prompt", values.prompt);
  if (!isFile(launchPath))
    throw new Error(`launch spec is not a file: ${launchPath}`);
  if (!isFile(promptPath))
    throw new Error(`prompt is not a file: ${promptPath}`);
  assertHostEnv(env);

  const spec = readLaunchSpec(launchPath);

  let sentPrompt = promptPath;
  if (spec.parent !== undefined) {
    sentPrompt = `${promptPath}.resume.md`;
    writeFileSync(
      sentPrompt,
      `${readFileSync(promptPath, "utf8")}\n${parentFooter(spec.parent, CLI_PATH)}\n`,
    );
  }
  const paneLine = paneCommandLine(CLI_PATH, launchPath, sentPrompt);

  // The new run must not read the earlier run's exit.
  if (spec.sessionFile !== undefined) removeExitSidecar(spec.sessionFile);

  const pane = createSurface(
    values.name ?? spec.name,
    placement,
    callerPaneId(env),
  );
  runInPane(pane, paneLine);

  write(JSON.stringify({ pane, launch: launchPath }) + "\n");
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

/** Parse `--timeout` as a positive number of seconds. */
function waitTimeoutSeconds(value: string | undefined): number {
  if (value === undefined) return DEFAULT_WAIT_TIMEOUT_S;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--timeout must be a positive number of seconds: ${value}`);
  }
  return seconds;
}

/**
 * `wait`: poll `<session>.exit` until the child writes its sidecar.
 *
 * The sidecar is the only signal: it survives the pane being closed, so no
 * host call and no screen read is needed. A missing file counts as no sidecar
 * yet.
 *
 * Waiting is strictly read-only: the sidecar is never removed here. The
 * child's pane-side wrapper reads the same file after the child process
 * exits — to close the pane on `done`/`handoff` and to quote a ping in the
 * no-report wake-up — and the child writes the sidecar while it is still
 * running, seconds before it exits. A waiting parent that deleted the file
 * would break both. Removal belongs to the parent, after it has read the
 * result: `resume` already removes the sidecar on relaunch, and the skill
 * teaches the same after a wait. The trade-off is that a repeated wait on
 * the same session reports the same exit again.
 *
 * Exit 0 prints the interpreted result as one JSON line (with the sidecar's
 * absolute path, so the parent knows what to clean up), exit 2 is a timeout,
 * exit 1 is a usage error.
 */
async function waitCommand(values: CliValues, deps: CliDeps): Promise<number> {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr =
    deps.stderr ?? ((text: string) => process.stderr.write(text));
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  try {
    const sessionPath = required("--session", values.session);
    const timeoutSeconds = waitTimeoutSeconds(values.timeout);

    const sidecarPath = exitSidecarPath(sessionPath);
    // The parent is told the absolute path so it can clean the file up
    // itself; waiting never removes it.
    const sidecarAbsPath = resolve(sidecarPath);
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      // The file's presence is the signal, not its content: a malformed
      // sidecar is still an exit, and `interpretExitSidecar` maps an unknown
      // payload to `done`.
      if (existsSync(sidecarPath)) {
        const result = interpretExitSidecar(readExitSidecar(sessionPath));
        write(JSON.stringify({ ...result, sidecar: sidecarAbsPath }) + "\n");
        return 0;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(WAIT_POLL_MS, remaining));
    }

    write(`${JSON.stringify({ sidecar: null })}\n`);
    writeErr(
      `timeout after ${timeoutSeconds}s: no exit sidecar was seen (a sidecar, if any, would have been printed; wait never removes it)\n`,
    );
    return 2;
  } catch (error) {
    // A usage error must leave stdout empty, so it is caught here instead of
    // bubbling to the entry wrapper.
    const message = error instanceof Error ? error.message : String(error);
    writeErr(`cli.ts: ${message}\n`);
    return 1;
  }
}

/** Parse `--max-age-days`, defaulting to `DEFAULT_PRUNE_MAX_AGE_DAYS`. */
function pruneMaxAgeDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PRUNE_MAX_AGE_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`--max-age-days must be a non-negative number: ${value}`);
  }
  return days;
}

/** `prune`: delete launcher files older than the retention. */
function pruneCommand(values: CliValues, deps: CliDeps): number {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const scratch = resolve(values.scratch ?? defaultScratchDir());
  const maxAgeDays = pruneMaxAgeDays(values["max-age-days"]);
  const dryRun = values["dry-run"] === true;
  const maxAgeMs = maxAgeDays * 86_400_000;
  const files = pruneScratch(scratch, { maxAgeMs, dryRun });
  write(
    JSON.stringify({
      scratch,
      maxAgeDays,
      dryRun,
      scanned: files.scanned,
      deleted: files.deleted,
      deletedBytes: files.deletedBytes,
    }) + "\n",
  );
  return 0;
}

/**
 * Route one parsed command to its implementation. `start` and `resume` share
 * the `--surface` flag, so both read the placement here.
 */
async function dispatch(
  command: string,
  values: CliValues,
  positionals: string[],
  deps: CliDeps,
  writeErr: (text: string) => void,
): Promise<number> {
  switch (command) {
    case "start": {
      const placement = surfacePlacement(values, writeErr);
      return placement === null ? 2 : startCommand(values, deps, placement);
    }
    case "resume": {
      const placement = surfacePlacement(values, writeErr);
      return placement === null ? 2 : resumeCommand(values, deps, placement);
    }
    case "send":
      return sendCommand(values);
    case "last-message":
      return lastMessageCommand(values, deps);
    case "wait":
      return waitCommand(values, deps);
    case "prune":
      return pruneCommand(values, deps);
    case "run":
      return runCommand(positionals.slice(1), deps);
    default:
      throw new Error(`unknown subcommand: ${command}\n${USAGE}`);
  }
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
  return dispatch(command, values as CliValues, positionals, deps, writeErr);
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
