import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findLastAssistantMessage,
  getNewEntries,
  type SessionEntry,
} from "../src/session.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("foreman-session-");

const SESSION_HEADER = { type: "session", id: "session-001" };
const MODEL_CHANGE = { type: "model_change", id: "model-001" };
const USER_MSG = {
  type: "message",
  id: "user-001",
  message: { role: "user", content: [{ type: "text", text: "do it" }] },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Updated plan with details." }],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  message: {
    role: "toolResult",
    content: [{ type: "text", text: "output here" }],
  },
};

/** Write a session file with one JSON object per line. */
let sessionCounter = 0;
function createSessionFile(dir: string, entries: unknown[]): string {
  sessionCounter += 1;
  const path = join(dir, `session-${sessionCounter}.jsonl`);
  writeFileSync(
    path,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  return path;
}

test("getNewEntries returns the entries after a given line", () => {
  withTempDir((dir) => {
    const file = createSessionFile(dir, [
      SESSION_HEADER,
      MODEL_CHANGE,
      USER_MSG,
      ASSISTANT_MSG,
    ]);
    const entries = getNewEntries(file, 2);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, "user-001");
    assert.equal(entries[1].id, "asst-001");
  });
});

test("getNewEntries returns nothing when there are no new entries", () => {
  withTempDir((dir) => {
    const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
    assert.deepEqual(getNewEntries(file, 2), []);
  });
});

test("getNewEntries skips a torn trailing line", () => {
  withTempDir((dir) => {
    const file = createSessionFile(dir, [
      SESSION_HEADER,
      MODEL_CHANGE,
      USER_MSG,
      ASSISTANT_MSG,
    ]);
    appendFileSync(file, '{"type":"message","id":"torn-');
    const entries = getNewEntries(file, 2);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, "user-001");
    assert.equal(entries[1].id, "asst-001");
  });
});

test("findLastAssistantMessage finds the last assistant text", () => {
  const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as SessionEntry[];
  assert.equal(findLastAssistantMessage(entries), "Updated plan with details.");
});

test("findLastAssistantMessage skips thinking blocks and takes text only", () => {
  const entries = [
    {
      type: "message",
      id: "asst-003",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Updated plan with details." },
        ],
      },
    },
  ] as unknown as SessionEntry[];
  assert.equal(findLastAssistantMessage(entries), "Updated plan with details.");
});

test("findLastAssistantMessage skips tool results", () => {
  const entries = [ASSISTANT_MSG, TOOL_RESULT] as SessionEntry[];
  assert.equal(findLastAssistantMessage(entries), "Here is my plan...");
});

test("findLastAssistantMessage returns null without an assistant message", () => {
  assert.equal(findLastAssistantMessage([USER_MSG] as SessionEntry[]), null);
  assert.equal(findLastAssistantMessage([]), null);
});

test("findLastAssistantMessage skips an empty assistant message", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Real summary content." }],
      },
    },
    { type: "message", message: { role: "assistant", content: [] } },
  ] as unknown as SessionEntry[];
  assert.equal(findLastAssistantMessage(entries), "Real summary content.");
});

test("findLastAssistantMessage surfaces the error message of a failed turn", () => {
  // The overload-exhaustion case: an earlier turn looked normal, then the
  // provider went 529 and auto-retry gave up. Without the errorMessage
  // fallback the parent would read the stale earlier summary and believe the
  // child completed.
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Investigating the bug..." }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    },
  ] as unknown as SessionEntry[];
  assert.equal(
    findLastAssistantMessage(entries),
    "Subagent error: Anthropic 529 Overloaded after 3 retries",
  );
});

test("findLastAssistantMessage prefers text over the error fallback", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is partial output." }],
        stopReason: "error",
        errorMessage: "stream interrupted",
      },
    },
  ] as unknown as SessionEntry[];
  assert.equal(findLastAssistantMessage(entries), "Here is partial output.");
});

test("findLastAssistantMessage invents nothing for an error turn with no message", () => {
  const entries = [
    {
      type: "message",
      message: { role: "assistant", content: [], stopReason: "error" },
    },
  ] as unknown as SessionEntry[];
  assert.equal(findLastAssistantMessage(entries), null);
});
