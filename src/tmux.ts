/**
 * tmux backend for subagent panes — the only supported terminal host.
 *
 * Every call runs the `tmux` binary directly (no shell, no command string).
 * The caller's pane identity comes from `$TMUX_PANE` — the pane this process
 * actually runs in — so a split always lands in the caller's own window.
 *
 * A subagent pane is created empty (the default shell) and the launch command
 * is sent to it afterwards, which keeps the pane alive after the child exits:
 * the wrapper prints the exit sentinel into the pane and closes it itself on
 * a clean completion.
 */
import { execFileSync } from "node:child_process";

/** Hard deadline for every tmux call: a wedged server must fail the call. */
export const TMUX_CALL_TIMEOUT_MS = 5000;

/**
 * Test seam: replaces the `tmux` invocation behind every call with an
 * in-process function, so the suite needs no tmux server and no shell.
 * Returns the raw stdout; `null` restores the real binary.
 */
export type TmuxExec = (args: string[]) => string;

let execOverride: TmuxExec | null = null;

export function __setTmuxExecForTests__(fn: TmuxExec | null): void {
  execOverride = fn;
}

/** Run a tmux command; returns stdout. */
function tmux(args: string[]): string {
  if (execOverride) return execOverride(args);
  return execFileSync("tmux", args, {
    encoding: "utf8",
    timeout: TMUX_CALL_TIMEOUT_MS,
  });
}

/** True when this process runs inside a tmux pane. */
export function isTmuxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.TMUX && env.TMUX_PANE);
}

/** The caller's own pane id, the anchor for every split. */
export function callerPaneId(env: NodeJS.ProcessEnv = process.env): string {
  const pane = env.TMUX_PANE;
  if (!pane)
    throw new Error("TMUX_PANE is not set. Start pi inside a tmux pane.");
  return pane;
}

/** The pane id in a tmux command's output, or a throw when there is none. */
function paneIdFrom(out: string): string {
  const surface = out.trim();
  if (!surface.startsWith("%")) {
    throw new Error(`Unexpected tmux split result (no pane id): ${surface}`);
  }
  return surface;
}

/** The tmux split flag for a direction: `-h` side by side, `-v` stacked. */
function splitFlag(direction: "right" | "down"): string {
  return direction === "down" ? "-v" : "-h";
}

/** Split a pane without taking focus and return the new pane id. */
function splitWindow(target: string, direction: "right" | "down"): string {
  return paneIdFrom(
    tmux([
      "split-window",
      "-d",
      splitFlag(direction),
      "-t",
      target,
      "-P",
      "-F",
      "#{pane_id}",
    ]),
  );
}

/**
 * Create a new pane for a subagent and return its id.
 *
 * `right` and `down` split the caller's pane without taking focus. `tab`
 * opens a new window in the caller's session and restores focus to the
 * caller's window afterwards. The pane is named best effort — a failed
 * naming is cosmetic, the pane works unnamed.
 */
export function createSurface(
  name: string,
  placement: "right" | "down" | "tab",
  caller = process.env.TMUX_PANE,
): string {
  if (!caller) {
    throw new Error("TMUX_PANE is not set. Start pi inside a tmux pane.");
  }

  let surface: string;
  if (placement === "tab") {
    const session = tmux([
      "display-message",
      "-p",
      "-t",
      caller,
      "#{session_id}",
    ]).trim();
    const created = tmux([
      "new-window",
      "-d",
      "-t",
      session,
      "-P",
      "-F",
      "#{pane_id}",
    ]);
    const callerWindow = tmux([
      "display-message",
      "-p",
      "-t",
      caller,
      "#{window_id}",
    ]).trim();
    try {
      tmux(["select-window", "-t", callerWindow]);
    } catch {
      // Focus restore is best effort; the new window exists either way.
    }
    surface = paneIdFrom(created);
  } else {
    surface = splitWindow(caller, placement);
  }

  try {
    namePane(surface, name);
  } catch {
    // Naming is cosmetic — the pane works unnamed.
  }
  return surface;
}

/**
 * Name a pane. The name becomes the pane title, which tmux shows on the pane
 * border when `pane-border-status` is on.
 */
export function namePane(surface: string, name: string): void {
  tmux(["select-pane", "-t", surface, "-T", name]);
}

/** Send one command line to a pane and execute it there. */
export function runInPane(surface: string, line: string): void {
  tmux(["send-keys", "-t", surface, "-l", line]);
  tmux(["send-keys", "-t", surface, "Enter"]);
}

/**
 * Deliver `text` to a pane as input and submit it: a literal paste followed
 * by Enter. Resolves as soon as the text is queued, without waiting for the
 * target to act. This is the report channel into the parent pane.
 */
export function sendToPane(pane: string, text: string): void {
  tmux(["send-keys", "-t", pane, "-l", text]);
  tmux(["send-keys", "-t", pane, "Enter"]);
}

/**
 * Close a pane. A pane that is already gone is not an error.
 */
export function closeSurface(surface: string): void {
  try {
    tmux(["kill-pane", "-t", surface]);
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    if (!/can't find pane|no such pane|not found/i.test(message)) throw error;
  }
}
