import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import foremanDone, {
  findLatestAssistantError,
  nudgeText,
  shouldAutoExitOnAgentEnd,
  shouldMarkUserTookOver,
  shouldScheduleAgentEndNudge,
} from "../extension/foreman-done/index.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDirAsync } = tempDirHelpers("foreman-done-");

/** The agent_end messages for one normally stopped assistant turn. */
const NORMAL_STOP = [{ role: "assistant", stopReason: "stop" }];
const ABORTED = [{ role: "assistant", stopReason: "aborted" }];
const ERROR = [
  {
    role: "assistant",
    stopReason: "error",
    errorMessage: "provider overloaded",
  },
];

/** A minimal ExtensionAPI fake: records handlers, tools and user messages. */
function makeMockPi() {
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => void>
  >();
  const registeredTools: Array<Record<string, unknown>> = [];
  const userMessages: Array<{ text: string; opts: unknown }> = [];
  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: Record<string, unknown>) {
      registeredTools.push(tool);
    },
    sendUserMessage(text: string, opts?: unknown) {
      userMessages.push({ text, opts });
      return Promise.resolve();
    },
  };
  function fire(event: string, payload?: unknown, ctx?: unknown): void {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
  }
  function tool(name: string): Record<string, any> {
    const found = registeredTools.find((t) => t.name === name);
    assert.ok(found, `expected ${name} to be registered`);
    return found;
  }
  return { api, fire, tool, userMessages, registeredTools };
}

/** A ctx fake counting shutdowns. `count.shutdowns` is read live. */
function makeCtx() {
  const count = { shutdowns: 0 };
  const ctx = { shutdown: () => (count.shutdowns += 1) };
  return { ctx, count };
}

/** Run one test with the child env set, restoring the process env after. */
async function withChildEnv<T>(
  env: Record<string, string>,
  run: () => Promise<T> | T,
): Promise<T> {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the decision helpers", () => {
  assert.equal(shouldScheduleAgentEndNudge(NORMAL_STOP), true);
  assert.equal(shouldScheduleAgentEndNudge(ABORTED), false);
  assert.equal(shouldScheduleAgentEndNudge(ERROR), false);
  assert.equal(shouldScheduleAgentEndNudge(undefined), false);

  assert.equal(shouldAutoExitOnAgentEnd(NORMAL_STOP), true);
  assert.equal(shouldAutoExitOnAgentEnd(ABORTED), false);
  assert.equal(shouldAutoExitOnAgentEnd(ERROR), true);
  assert.equal(shouldAutoExitOnAgentEnd(undefined), true);

  assert.equal(shouldMarkUserTookOver(false), false);
  assert.equal(shouldMarkUserTookOver(true), true);

  assert.deepEqual(findLatestAssistantError(ERROR), {
    errorMessage: "provider overloaded",
    stopReason: "error",
  });
  assert.deepEqual(
    findLatestAssistantError([{ role: "assistant", stopReason: "error" }]),
    {
      errorMessage:
        "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    },
  );
  assert.equal(findLatestAssistantError(NORMAL_STOP), null);
  assert.equal(findLatestAssistantError(undefined), null);
});

test("the nudge text sends the report before foreman_done and never claims delivery", () => {
  const text = nudgeText();
  assert.match(
    text,
    /send your final report with the send command .* then call the foreman_done tool/,
  );
  assert.doesNotMatch(text, /already delivered/);
});

test("foreman_done writes a done sidecar and shuts down", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "s.jsonl");
    await withChildEnv(
      { PI_FOREMAN_SESSION: sessionFile, PI_FOREMAN_NAME: "worker" },
      async () => {
        const { api, tool } = makeMockPi();
        foremanDone(api as never);
        const { ctx, count } = makeCtx();
        const result = await tool("foreman_done").execute(
          "c1",
          {},
          undefined,
          undefined,
          ctx,
        );
        assert.equal(count.shutdowns, 1);
        assert.deepEqual(
          JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
          { type: "done" },
        );
        assert.match(result.content[0].text, /Shutting down/);
      },
    );
  });
});

test("foreman_done with a handoff writes the handoff sidecar", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "s.jsonl");
    await withChildEnv({ PI_FOREMAN_SESSION: sessionFile }, async () => {
      const { api, tool } = makeMockPi();
      foremanDone(api as never);
      const { ctx, count } = makeCtx();
      await tool("foreman_done").execute(
        "c1",
        { handoff: "goal: x. done: y. left: z." },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(count.shutdowns, 1);
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
        {
          type: "handoff",
          message: "goal: x. done: y. left: z.",
        },
      );
    });
  });
});

test("a whitespace-only handoff fails before any sidecar or shutdown", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "s.jsonl");
    await withChildEnv({ PI_FOREMAN_SESSION: sessionFile }, async () => {
      const { api, tool } = makeMockPi();
      foremanDone(api as never);
      const { ctx, count } = makeCtx();
      await assert.rejects(
        tool("foreman_done").execute(
          "c1",
          { handoff: "   " },
          undefined,
          undefined,
          ctx,
        ),
        /non-empty string/,
      );
      assert.equal(count.shutdowns, 0);
      assert.equal(existsSync(`${sessionFile}.exit`), false);
    });
  });
});

test("foreman_ping writes a ping sidecar carrying the child's name and question", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "s.jsonl");
    await withChildEnv(
      { PI_FOREMAN_SESSION: sessionFile, PI_FOREMAN_NAME: "worker" },
      async () => {
        const { api, tool } = makeMockPi();
        foremanDone(api as never);
        const { ctx, count } = makeCtx();
        await tool("foreman_ping").execute(
          "c1",
          { message: "which branch?" },
          undefined,
          undefined,
          ctx,
        );
        assert.equal(count.shutdowns, 1);
        assert.deepEqual(
          JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
          {
            type: "ping",
            name: "worker",
            message: "which branch?",
          },
        );
      },
    );
  });
});

test("foreman_ping refuses to run outside a subagent context", async () => {
  await withChildEnv({}, async () => {
    const { api, tool } = makeMockPi();
    foremanDone(api as never);
    const { ctx } = makeCtx();
    await assert.rejects(
      tool("foreman_ping").execute(
        "c1",
        { message: "hi" },
        undefined,
        undefined,
        ctx,
      ),
      /PI_FOREMAN_SESSION/,
    );
  });
});

test("auto-exit: a normal agent_end writes done and shuts down", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "s.jsonl");
    await withChildEnv(
      { PI_FOREMAN_SESSION: sessionFile, PI_FOREMAN_AUTO_EXIT: "1" },
      async () => {
        const { api, fire, tool, userMessages } = makeMockPi();
        foremanDone(api as never);
        fire("session_start");
        fire("agent_start");
        const { ctx, count } = makeCtx();
        fire("agent_end", { messages: NORMAL_STOP }, ctx);
        assert.equal(count.shutdowns, 1);
        assert.deepEqual(
          JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
          { type: "done" },
        );
        assert.deepEqual(userMessages, []);
        assert.ok(tool("foreman_done"));
        assert.ok(tool("foreman_ping"));
      },
    );
  });
});

test("an aborted turn stays open and schedules no nudge", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "s.jsonl");
    await withChildEnv(
      {
        PI_FOREMAN_SESSION: sessionFile,
        PI_FOREMAN_AUTO_EXIT: "1",
        PI_FOREMAN_NUDGE_DELAY_MS: "1000",
      },
      async () => {
        const { api, fire, userMessages } = makeMockPi();
        foremanDone(api as never);
        fire("session_start");
        fire("agent_start");
        const { ctx, count } = makeCtx();
        fire("agent_end", { messages: ABORTED }, ctx);
        assert.equal(count.shutdowns, 0);
        assert.equal(existsSync(`${sessionFile}.exit`), false);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.deepEqual(userMessages, []);
      },
    );
  });
});

test("a normal stop without auto-exit nudges after the delay", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "s.jsonl");
    await withChildEnv(
      { PI_FOREMAN_SESSION: sessionFile, PI_FOREMAN_NUDGE_DELAY_MS: "1000" },
      async () => {
        const { api, fire, userMessages } = makeMockPi();
        foremanDone(api as never);
        fire("session_start");
        fire("agent_start");
        const { ctx, count } = makeCtx();
        fire("agent_end", { messages: NORMAL_STOP }, ctx);
        assert.equal(count.shutdowns, 0);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.equal(userMessages.length, 1);
        assert.match(userMessages[0].text, /foreman_done/);
      },
    );
  });
});

test("user input after the first run takes over and blocks auto-exit", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "s.jsonl");
    await withChildEnv(
      { PI_FOREMAN_SESSION: sessionFile, PI_FOREMAN_AUTO_EXIT: "1" },
      async () => {
        const { api, fire } = makeMockPi();
        foremanDone(api as never);
        fire("session_start");
        fire("agent_start");
        fire("agent_end", { messages: NORMAL_STOP }, makeCtx().ctx); // first run auto-exits
        // The first run wrote its done sidecar and shut down in production;
        // a second run only happens when a user resumed the pane, and the
        // parent consumed the sidecar by then. Simulate that:
        rmSync(`${sessionFile}.exit`, { force: true });
        fire("session_start");
        fire("agent_start");
        fire("input");
        const { ctx, count } = makeCtx();
        fire("agent_end", { messages: NORMAL_STOP }, ctx);
        assert.equal(count.shutdowns, 0);
        assert.equal(existsSync(`${sessionFile}.exit`), false);
      },
    );
  });
});

test("an error turn writes the error sidecar and shuts down", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "s.jsonl");
    await withChildEnv({ PI_FOREMAN_SESSION: sessionFile }, async () => {
      const { api, fire } = makeMockPi();
      foremanDone(api as never);
      fire("session_start");
      const { ctx, count } = makeCtx();
      fire("agent_end", { messages: ERROR }, ctx);
      assert.equal(count.shutdowns, 1);
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
        {
          type: "error",
          errorMessage: "provider overloaded",
          stopReason: "error",
        },
      );
    });
  });
});

test("a sidecar from an earlier run is overwritten by a fresh exit", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "s.jsonl");
    await withChildEnv({ PI_FOREMAN_SESSION: sessionFile }, async () => {
      const { api, fire } = makeMockPi();
      foremanDone(api as never);
      fire("session_start");
      const { ctx } = makeCtx();
      fire("agent_end", { messages: ERROR }, ctx);
      assert.equal(
        JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")).type,
        "error",
      );
      rmSync(`${sessionFile}.exit`);
      assert.equal(existsSync(`${sessionFile}.exit`), false);
    });
  });
});
