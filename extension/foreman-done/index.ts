/**
 * Extension loaded into every foreman child (the launch spec passes it with
 * pi's `-e`).
 *
 * - Provides a `foreman_done` tool: the child ends its own session, after it
 *   sent its report to the parent pane with the `send` command from its brief.
 *   It writes the `done` (or `handoff`) `.exit` sidecar.
 * - Provides a `foreman_ping` tool: a blocked child ends its session with a
 *   `ping` sidecar; the parent's wrapper wake-up and `wait` decode it.
 * - Nudges any agent that forgets to call `foreman_done` after generating.
 * - Auto-exit: with `PI_FOREMAN_AUTO_EXIT=1`, a normal `agent_end` (no user
 *   takeover, not aborted) writes the `done` `.exit` sidecar and shuts the
 *   session down. Provider-error turns write the `error` sidecar so the
 *   parent learns about failures promptly.
 *
 * The report channel itself is not a tool: the child reaches the parent pane
 * with `node <cli> send --to <parent-pane> --text '...'`, as its brief's
 * footer teaches. Everything here is host independent — no tmux calls, no
 * Luvus calls, no status files.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { decodeChildEnv } from "../../src/child-env.ts";
import { writeExitSidecar } from "../../src/exit-sidecar.ts";

const ASSISTANT_ROLE = "assistant";
const NORMAL_STOP_REASON = "stop";

/** Return true only when the latest assistant message ended by the model stopping normally. */
export function shouldScheduleAgentEndNudge(
  messages: readonly { role?: string; stopReason?: string }[] | undefined,
): boolean {
  if (!messages) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === ASSISTANT_ROLE) {
      return message.stopReason === NORMAL_STOP_REASON;
    }
  }

  return false;
}

export function shouldAutoExitOnAgentEnd(messages: any[] | undefined): boolean {
  // If the latest agent turn completed normally, close the session. Escape/abort
  // still leaves it open for inspection or another prompt. User takeover is the
  // caller's concern.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === ASSISTANT_ROLE) {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== ASSISTANT_ROLE) continue;
    if (msg.stopReason !== "error") return null;
    const raw =
      typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage:
        raw ||
        "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/** The nudge text: foreman children must SEND the report, then call foreman_done. */
export function nudgeText(): string {
  return (
    "[Automated reminder] Your last turn ended but this session is still open.\n" +
    "If your task is complete, send your final report with the send command from your brief first, " +
    "then call the foreman_done tool now, with no other text. Do not repeat your report.\n" +
    "If you are blocked and need input from the caller, send your question with the send command and stop.\n" +
    "Otherwise, continue working."
  );
}

export default function foremanDone(pi: ExtensionAPI) {
  // Decode the child env once: a pi process does not change its own
  // PI_FOREMAN_* values. Every child-env reader below uses this value; the
  // nudge settings stay direct process settings.
  const childEnv = decodeChildEnv(process.env);
  const sessionFile = childEnv.sessionFile;

  // ── Agent completion nudge configuration ──
  /** Delay (ms) before sending a nudge after agent_end. Configurable via env var. */
  const NUDGE_DELAY_MS = Math.max(
    1000,
    parseInt(process.env.PI_FOREMAN_NUDGE_DELAY_MS ?? "5000", 10) || 5000,
  );
  /** Set to "1" to disable the nudge entirely. */
  const NUDGE_DISABLED = process.env.PI_FOREMAN_NUDGE_DISABLE === "1";

  let doneCalled = false;
  let userInputAfterAgentEnd = false;
  let userTookOver = false;
  let agentStarted = false;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cancel and forget the pending completion reminder, if any. */
  function clearNudgeTimer(): void {
    if (nudgeTimer !== null) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
  }

  /**
   * After a subagent stops normally, schedule a nudge reminding it to send
   * its report and call foreman_done. Error and aborted runs are excluded.
   *
   * Each call replaces any pending nudge, so repeated agent_end events
   * automatically reset the timer. The nudge only fires if no new agent
   * activity or user input arrives within NUDGE_DELAY_MS.
   */
  function scheduleAgentEndNudge(pi: ExtensionAPI): void {
    clearNudgeTimer();
    if (NUDGE_DISABLED || doneCalled) return;

    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      if (doneCalled || userInputAfterAgentEnd) return;
      void pi.sendUserMessage(nudgeText(), { deliverAs: "followUp" });
    }, NUDGE_DELAY_MS);
  }

  pi.on("session_start", () => {
    doneCalled = false;
    userInputAfterAgentEnd = false;
    userTookOver = false;
    clearNudgeTimer();
  });

  pi.on("input", () => {
    // User typed something — they are in control, cancel any pending nudge.
    userInputAfterAgentEnd = true;
    clearNudgeTimer();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover,
    // which keeps an auto-exit session open instead of exiting it.
    if (shouldMarkUserTookOver(agentStarted)) userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    // Agent is about to generate — clear any pending nudge; the AI is active.
    clearNudgeTimer();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    // Agent has started a new generation cycle — clear any pending nudge.
    userInputAfterAgentEnd = false;
    clearNudgeTimer();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;

    // A sidecar the child already wrote is final: no path may replace it.
    // `foreman_ping` and `foreman_done` set `doneCalled` and write their own
    // sidecar (ping, handoff or done) before shutting the session down, so
    // the error and auto-exit branches below must not act: they would
    // clobber the child's report with a `done` or `error` sidecar, and
    // shutdown a second time.
    if (doneCalled) return;

    // Error turns still exit so the parent learns about the failure promptly
    // (auto-retry exhausted, provider overload, etc.). Without this the parent
    // would only see exit code 0 and a stale assistant message, mistaking the
    // crash for a successful completion.
    const errorInfo = findLatestAssistantError(messages);
    if (errorInfo && sessionFile) {
      writeExitSidecar(sessionFile, {
        type: "error",
        errorMessage: errorInfo.errorMessage,
        stopReason: errorInfo.stopReason,
      });
      ctx.shutdown();
      return;
    }

    // Only input arriving after this point counts as a takeover; input that
    // landed mid-run must not silence the nudge.
    userInputAfterAgentEnd = false;

    // Auto-exit: an auto-exit agent whose turn ended normally exits itself
    // instead of waiting on the nudge. A taken-over session stays open
    // (falls through to the nudge path); aborted stops stay open; the error
    // branch above already handled provider failures.
    if (
      childEnv.autoExit &&
      !userTookOver &&
      shouldAutoExitOnAgentEnd(messages)
    ) {
      if (sessionFile) writeExitSidecar(sessionFile, { type: "done" });
      ctx.shutdown();
      return;
    }

    // A normal stop leaves the session open and nudges the agent to send its
    // report and call foreman_done if it forgot.
    if (shouldScheduleAgentEndNudge(messages)) {
      scheduleAgentEndNudge(pi);
    } else {
      clearNudgeTimer();
    }
  });

  pi.on("session_shutdown", () => {
    clearNudgeTimer();
  });

  pi.registerTool({
    name: "foreman_ping",
    label: "Foreman Ping",
    description:
      "Ask the parent for help, then END your session. The parent gets your ping and can resume you with a reply. " +
      "Use it when you are blocked or need a decision. " +
      "To deliver a report or a question while you keep working, use the send command from your brief instead.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!sessionFile) {
        throw new Error(
          "foreman_ping is only available in subagent contexts. " +
            "PI_FOREMAN_SESSION environment variable is not set.",
        );
      }

      doneCalled = true;
      clearNudgeTimer();
      writeExitSidecar(sessionFile, {
        type: "ping",
        name: childEnv.name ?? "subagent",
        message: params.message,
      });

      ctx.shutdown();
      return {
        content: [
          {
            type: "text",
            text: "Ping sent. Session will exit and parent will be notified.",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "foreman_done",
    label: "Foreman Done",
    description:
      "Call this when your task is complete, AFTER you sent your final report with the send command from your brief. " +
      "It ENDS your session. " +
      "Pass `handoff` only to end with a handoff: it ends the session with a handoff sidecar carrying that text " +
      "for a fresh agent, and the task is reported as not complete.",
    parameters: Type.Object({
      handoff: Type.Optional(
        Type.String({
          description:
            "Handoff text for a fresh agent: the goal, what is done, what is left, and the current state.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // A whitespace-only handoff must fail before any state changes, so the
      // session stays open and the model can retry with real text.
      if (
        params.handoff !== undefined &&
        (typeof params.handoff !== "string" || params.handoff.trim() === "")
      ) {
        throw new Error(
          "foreman_done handoff must be a non-empty string: the handoff text a fresh agent needs to continue the task.",
        );
      }
      doneCalled = true;
      clearNudgeTimer();
      // The orchestrator learns that the task is not complete from the sidecar.
      if (sessionFile) {
        writeExitSidecar(
          sessionFile,
          typeof params.handoff === "string"
            ? { type: "handoff", message: params.handoff }
            : { type: "done" },
        );
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
