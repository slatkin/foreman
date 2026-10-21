/**
 * The `.exit` sidecar protocol — host independent.
 *
 * A child writes `<session file>.exit` when it finishes (done, ping, handoff
 * or error). The parent polls that file, so the completion channel does not
 * depend on the terminal host. The sidecar survives the pane being closed,
 * which is what makes it the only signal `wait` needs.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "sentinel" | "error" | "handoff";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Handoff data if reason is "handoff" */
  handoff?: { message: string };
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
  /** Who wrote the error sidecar: the child's own error path, or the wrapper. */
  errorSource?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by foreman_done / the error
 * path in the child extension / the wrapper's crash path). Centralized so
 * every reader decodes a payload the same way.
 */
export function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: { name: data.name, message: data.message },
    };
  }
  if (data?.type === "handoff") {
    const message =
      typeof data.message === "string" && data.message.trim() !== ""
        ? data.message
        : "(handoff text missing)";
    return { reason: "handoff", exitCode: 0, handoff: { message } };
  }
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return {
      reason: "error",
      exitCode: 1,
      errorMessage,
      ...(typeof data.source === "string" ? { errorSource: data.source } : {}),
    };
  }
  return { reason: "done", exitCode: 0 };
}

/** The `.exit` sidecar path next to a session file. */
export function exitSidecarPath(sessionFile: string): string {
  return `${sessionFile}.exit`;
}

/**
 * Read the `.exit` sidecar next to a session file. Returns the parsed JSON, or
 * null when the file is missing or is not valid JSON. Never deletes the file —
 * callers that consume a sidecar remove it themselves.
 */
export function readExitSidecar(sessionFile: string): any {
  try {
    return JSON.parse(readFileSync(exitSidecarPath(sessionFile), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write the `.exit` sidecar next to a session file. Never throws: a failed
 * write only costs the parent its exit signal.
 */
export function writeExitSidecar(sessionFile: string, data: unknown): boolean {
  try {
    writeFileSync(exitSidecarPath(sessionFile), JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the `.exit` sidecar next to a session file, so a later run never
 * reads an earlier run's exit. A missing file is fine. Never throws.
 */
export function removeExitSidecar(sessionFile: string): void {
  try {
    rmSync(exitSidecarPath(sessionFile), { force: true });
  } catch {
    // Best effort: a stale sidecar only costs one poll cycle.
  }
}
