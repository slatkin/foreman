import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSpec } from "../src/run.ts";
import { writeExitSidecar } from "../src/exit-sidecar.ts";
import { LAUNCH_SPEC_VERSION, type LaunchSpec } from "../src/launch.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDirAsync } = tempDirHelpers("foreman-run-");

/** A child command that exits with the given code, via this node itself. */
function exitSpec(code: number): LaunchSpec {
  return {
    version: LAUNCH_SPEC_VERSION,
    name: "worker",
    env: {},
    command: process.execPath,
    args: ["-e", `process.exit(${code})`],
  };
}

/** A spec override helper that keeps the version stamp. */
function spec(overrides: Partial<LaunchSpec>): LaunchSpec {
  return { ...exitSpec(0), ...overrides };
}

const RUN_ENV = { TMUX: "/tmp/tmux-0/x,1,0", TMUX_PANE: "%9" };

/** The repo's CLI, for a child command that really runs the send subcommand. */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("a clean child prints the sentinel and returns its code", async () => {
  await withTempDirAsync(async (_dir) => {
    let out = "";
    const code = await runSpec(exitSpec(0), undefined, {
      env: RUN_ENV,
      stdout: (t) => (out += t),
    });
    assert.equal(code, 0);
    assert.equal(out, "__SUBAGENT_DONE_0__\n");
  });
});

test("a failing child carries its code in the sentinel", async () => {
  await withTempDirAsync(async (_dir) => {
    let out = "";
    const code = await runSpec(exitSpec(3), undefined, {
      env: RUN_ENV,
      stdout: (t) => (out += t),
    });
    assert.equal(code, 3);
    assert.equal(out, "__SUBAGENT_DONE_3__\n");
  });
});

test("a command that cannot start reports code 127", async () => {
  await withTempDirAsync(async (_dir) => {
    let out = "";
    let err = "";
    const code = await runSpec(
      spec({ command: "/nonexistent/foreman-child-bin", args: [] }),
      undefined,
      { env: RUN_ENV, stdout: (t) => (out += t), stderr: (t) => (err += t) },
    );
    assert.equal(code, 127);
    assert.equal(out, "__SUBAGENT_DONE_127__\n");
    assert.match(err, /Failed to start/);
  });
});

test("a child that exits without a report wakes the parent", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = `${dir}/s.jsonl`;
    const woken: Array<{ to: string; text: string }> = [];
    await runSpec(spec({ sessionFile, parent: "%3" }), undefined, {
      env: RUN_ENV,
      stdout: () => {},
      sendToParent: (to, text) => woken.push({ to, text }),
    });
    assert.equal(woken.length, 1);
    assert.equal(woken[0].to, "%3");
    assert.match(woken[0].text, /worker exited without sending a report/);
    assert.match(woken[0].text, /last-message --session/);
  });
});

test("a child that crashed names the exit code in the wake-up", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = `${dir}/s.jsonl`;
    const woken: string[] = [];
    await runSpec(
      spec({
        command: process.execPath,
        args: ["-e", "process.exit(2)"],
        sessionFile,
        parent: "%3",
      }),
      undefined,
      {
        env: RUN_ENV,
        stdout: () => {},
        sendToParent: (_to, text) => woken.push(text),
      },
    );
    assert.match(woken[0], /worker crashed \(code 2\)/);
  });
});

test("a ping sidecar is quoted in the wake-up", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = `${dir}/s.jsonl`;
    writeExitSidecar(sessionFile, {
      type: "ping",
      name: "worker",
      message: "need a decision on the axis",
    });
    const woken: string[] = [];
    await runSpec(spec({ sessionFile, parent: "%3" }), undefined, {
      env: RUN_ENV,
      stdout: () => {},
      sendToParent: (_to, text) => woken.push(text),
    });
    assert.equal(woken.length, 1);
    assert.match(woken[0], /worker pinged: need a decision on the axis/);
  });
});

test("a child that reported is not woken again", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = `${dir}/s.jsonl`;
    // The real mechanism: the child's spec.env carries PI_FOREMAN_SESSION and
    // its command actually runs the send subcommand, which appends a receipt
    // to `<session>.sent` — the file the wrapper counts. The report text can
    // contain anything; only the receipt decides. A stub `tmux` on the
    // child's PATH keeps the delivery hermetic.
    const bin = `${dir}/bin`;
    mkdirSync(bin, { recursive: true });
    const stub = `${bin}/tmux`;
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
    const child = spec({
      sessionFile,
      parent: "%3",
      env: {
        PI_FOREMAN_SESSION: sessionFile,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      args: [CLI, "send", "--to", "%3", "--text", "all done, commit abc"],
    });
    const woken: string[] = [];
    await runSpec(child, undefined, {
      env: RUN_ENV,
      stdout: () => {},
      sendToParent: (_to, text) => woken.push(text),
    });
    assert.deepEqual(woken, []);
  });
});

test("the footer's own placeholders do not count as reports", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = `${dir}/s.jsonl`;
    // The prompt file is full of send-command placeholders, but a placeholder
    // is not a report: without a receipt file (`<session>.sent`, written by a
    // real send inside the child) the wrapper wakes the parent.
    writeFileSync(
      sessionFile,
      "node /cli.ts send --to %3 --text '<text>'\nnode /cli.ts send --to %3 --text '<verdict / commit SHA / files changed / verification / deviations / open questions>'\n",
    );
    const woken: string[] = [];
    await runSpec(spec({ sessionFile, parent: "%3" }), undefined, {
      env: RUN_ENV,
      stdout: () => {},
      sendToParent: (_to, text) => woken.push(text),
    });
    assert.equal(woken.length, 1);
  });
});

test("close-on-done closes the pane after a done sidecar and its grace", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = `${dir}/s.jsonl`;
    writeExitSidecar(sessionFile, { type: "done" });
    const sleeps: number[] = [];
    const closed: string[] = [];
    await runSpec(
      spec({ sessionFile, closeOnDone: { graceMs: 40 } }),
      undefined,
      {
        env: RUN_ENV,
        stdout: () => {},
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        closePane: (pane) => closed.push(pane),
      },
    );
    assert.deepEqual(sleeps, [40]);
    assert.deepEqual(closed, ["%9"]);
  });
});

test("close-on-done also closes on a handoff sidecar", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = `${dir}/s.jsonl`;
    writeExitSidecar(sessionFile, { type: "handoff", message: "next steps" });
    const closed: string[] = [];
    await runSpec(
      spec({ sessionFile, closeOnDone: { graceMs: 0 } }),
      undefined,
      {
        env: RUN_ENV,
        stdout: () => {},
        closePane: (pane) => closed.push(pane),
      },
    );
    assert.deepEqual(closed, ["%9"]);
  });
});

test("error, ping and sidecar-less panes stay open", async () => {
  await withTempDirAsync(async (dir) => {
    for (const sidecar of [
      { type: "error", errorMessage: "boom" },
      { type: "ping", name: "n", message: "m" },
    ]) {
      const sessionFile = `${dir}/${sidecar.type}.jsonl`;
      writeExitSidecar(sessionFile, sidecar);
      const closed: string[] = [];
      await runSpec(
        spec({ sessionFile, closeOnDone: { graceMs: 0 } }),
        undefined,
        {
          env: RUN_ENV,
          stdout: () => {},
          closePane: (pane) => closed.push(pane),
        },
      );
      assert.deepEqual(closed, [], `${sidecar.type} must not close`);
    }

    // No sidecar at all: the child crashed; the pane stays open.
    const closed: string[] = [];
    await runSpec(
      spec({
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
        sessionFile: `${dir}/none.jsonl`,
        closeOnDone: { graceMs: 0 },
      }),
      undefined,
      {
        env: RUN_ENV,
        stdout: () => {},
        closePane: (pane) => closed.push(pane),
      },
    );
    assert.deepEqual(closed, []);
  });
});

test("close-on-done without a pane id never closes", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = `${dir}/s.jsonl`;
    writeExitSidecar(sessionFile, { type: "done" });
    const closed: string[] = [];
    await runSpec(
      spec({ sessionFile, closeOnDone: { graceMs: 0 } }),
      undefined,
      {
        env: {},
        stdout: () => {},
        closePane: (pane) => closed.push(pane),
      },
    );
    assert.deepEqual(closed, []);
  });
});

test("the prompt path is appended as @<path>", async () => {
  await withTempDirAsync(async (dir) => {
    const promptPath = `${dir}/p.prompt.md`;
    writeFileSync(promptPath, "Do it.\n");
    const argvFile = `${dir}/argv.json`;
    // The child's stdio is inherited, so it cannot answer through the sink;
    // it dumps its argv to a file instead. The appended @prompt is the last
    // argv entry.
    const code = await runSpec(
      spec({
        args: [
          "-e",
          `require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv))`,
          argvFile,
        ],
      }),
      promptPath,
      { env: RUN_ENV, stdout: () => {} },
    );
    assert.equal(code, 0);
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    assert.equal(argv[argv.length - 1], `@${promptPath}`);
  });
});
