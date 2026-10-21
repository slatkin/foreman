import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { exitSidecarPath } from "../src/exit-sidecar.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDirAsync } = tempDirHelpers("foreman-wait-");

interface WaitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One `wait` invocation with captured stdout and stderr. */
async function runWait(
  argv: string[],
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<WaitResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(["wait", ...argv], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    ...deps,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("wait prints the interpreted sidecar and consumes it", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "child.jsonl");
    const sidecar = exitSidecarPath(sessionFile);
    writeFileSync(sidecar, JSON.stringify({ type: "done" }));
    const result = await runWait(["--session", sessionFile, "--timeout", "5"]);
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      `${JSON.stringify({ reason: "done", exitCode: 0 })}\n`,
    );
    assert.equal(result.stderr, "");
    // The parent consumes the sidecar: it is gone after the wait.
    assert.equal(existsSync(sidecar), false);
  });
});

test("wait prints the ping payload of a ping sidecar", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(
      exitSidecarPath(sessionFile),
      JSON.stringify({ type: "ping", name: "worker", message: "need answer" }),
    );
    const result = await runWait(["--session", sessionFile, "--timeout", "5"]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      reason: "ping",
      exitCode: 0,
      ping: { name: "worker", message: "need answer" },
    });
  });
});

test("wait times out with the null sidecar line and a message on stderr", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "child.jsonl");
    const result = await runWait([
      "--session",
      sessionFile,
      "--timeout",
      "0.05",
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, `${JSON.stringify({ sidecar: null })}\n`);
    assert.match(result.stderr, /timeout/);
    assert.match(result.stderr, /no exit sidecar/);
  });
});

test("wait picks up a sidecar that appears while it polls", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "child.jsonl");
    const sidecar = exitSidecarPath(sessionFile);
    let polls = 0;
    const result = await runWait(["--session", sessionFile, "--timeout", "5"], {
      sleep: async () => {
        polls += 1;
        if (polls === 1) {
          writeFileSync(sidecar, JSON.stringify({ type: "done" }));
        }
      },
    });
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      `${JSON.stringify({ reason: "done", exitCode: 0 })}\n`,
    );
    assert.equal(existsSync(sidecar), false);
  });
});

test("wait does not crash on a malformed sidecar", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "child.jsonl");
    const sidecar = exitSidecarPath(sessionFile);
    writeFileSync(sidecar, "not json at all");
    const result = await runWait(["--session", sessionFile, "--timeout", "5"]);
    assert.equal(result.code, 0);
    // An unknown payload maps to `done`.
    assert.equal(
      result.stdout,
      `${JSON.stringify({ reason: "done", exitCode: 0 })}\n`,
    );
    assert.equal(existsSync(sidecar), false);
  });
});

test("wait exits 1 with nothing on stdout for a usage error", async () => {
  await withTempDirAsync(async (dir) => {
    const sessionFile = join(dir, "child.jsonl");
    const missingSession = await runWait(["--timeout", "5"]);
    assert.equal(missingSession.code, 1);
    assert.equal(missingSession.stdout, "");
    assert.match(missingSession.stderr, /--session/);

    for (const [label, arg] of [
      ["0", "--timeout=0"],
      ["-3", "--timeout=-3"],
      ["abc", "--timeout=abc"],
    ] as const) {
      const badTimeout = await runWait(["--session", sessionFile, arg]);
      assert.equal(badTimeout.code, 1, `--timeout ${label}`);
      assert.equal(badTimeout.stdout, "");
      assert.match(badTimeout.stderr, /--timeout/);
    }
  });
});
