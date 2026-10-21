import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LAUNCH_SPEC_VERSION,
  buildPaneTitle,
  paneCommandLine,
  readLaunchSpec,
  resolvePiCommand,
  validateLaunchSpec,
  writeLaunchSpec,
  type LaunchSpec,
} from "../src/launch.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("foreman-launch-");

function minimalSpec(): LaunchSpec {
  return {
    version: LAUNCH_SPEC_VERSION,
    name: "scout",
    env: { PI_FOREMAN_SESSION: "/tmp/s.jsonl" },
    command: "pi",
    args: ["--session", "/tmp/s.jsonl"],
  };
}

test("round-trips a full spec through write and read", () => {
  withTempDir((dir) => {
    const spec: LaunchSpec = {
      version: LAUNCH_SPEC_VERSION,
      name: "worker",
      cwd: "/repo",
      env: { PI_FOREMAN_NAME: "worker" },
      command: "pi",
      args: ["--name", "worker"],
      sessionFile: "/tmp/w.jsonl",
      title: "worker — task",
      closeOnDone: { graceMs: 5000 },
      parent: "%3",
    };
    const path = `${dir}/spec.json`;
    writeLaunchSpec(path, spec);
    assert.deepEqual(readLaunchSpec(path), spec);
  });
});

test("rejects an unknown version", () => {
  assert.throws(
    () => validateLaunchSpec({ ...minimalSpec(), version: 99 }),
    /unknown version/,
  );
});

test("rejects a non-object payload", () => {
  assert.throws(() => validateLaunchSpec(null), /expected a JSON object/);
  assert.throws(() => validateLaunchSpec([1]), /expected a JSON object/);
});

test("rejects missing name and command", () => {
  assert.throws(
    () => validateLaunchSpec({ version: LAUNCH_SPEC_VERSION }),
    /missing name/,
  );
  assert.throws(
    () => validateLaunchSpec({ version: LAUNCH_SPEC_VERSION, name: "x" }),
    /missing command/,
  );
});

test("rejects non-string env values and non-string args", () => {
  assert.throws(
    () => validateLaunchSpec({ ...minimalSpec(), env: { A: 1 } }),
    /env\.A must be a string/,
  );
  assert.throws(
    () => validateLaunchSpec({ ...minimalSpec(), args: [1] }),
    /array of strings/,
  );
});

test("rejects a negative closeOnDone grace", () => {
  assert.throws(
    () =>
      validateLaunchSpec({ ...minimalSpec(), closeOnDone: { graceMs: -1 } }),
    /non-negative/,
  );
});

test("env and args default to empty", () => {
  const spec = validateLaunchSpec({
    version: LAUNCH_SPEC_VERSION,
    name: "x",
    command: "pi",
  });
  assert.deepEqual(spec.env, {});
  assert.deepEqual(spec.args, []);
});

test("paneCommandLine quotes every token and leads with bare node", () => {
  const line = paneCommandLine(
    "/opt/foreman/src/cli.ts",
    "/tmp/a b.json",
    "/tmp/p.prompt.md",
  );
  assert.equal(
    line,
    'node "/opt/foreman/src/cli.ts" "run" "/tmp/a b.json" "/tmp/p.prompt.md"',
  );
});

test("paneCommandLine rejects tokens a shell would expand", () => {
  for (const bad of [
    "/tmp/a$b.json",
    "/tmp/a`b.json",
    '/tmp/a"b.json',
    "/tmp/a%b.json",
  ]) {
    assert.throws(
      () => paneCommandLine("/cli.ts", bad),
      /Unsafe pane command token/,
    );
  }
});

test("buildPaneTitle cuts the task to 48 characters on one line", () => {
  assert.equal(
    buildPaneTitle("scout", "first line\nsecond line"),
    "scout — first line",
  );
  const long = "x".repeat(60);
  assert.equal(buildPaneTitle("scout", long).length, "scout — ".length + 48);
  assert.equal(buildPaneTitle("scout"), "scout");
  // Control characters cannot smuggle an escape sequence into the title: the
  // ESC is stripped, leaving the rest of the line as plain text.
  assert.equal(buildPaneTitle("scout", "\x1b]0;evil"), "scout — ]0;evil");
});

test("resolvePiCommand honours an explicit entry override", () => {
  const resolved = resolvePiCommand({
    env: { PI_FOREMAN_PI_ENTRY: "/pi/entry.mjs" },
  });
  assert.equal(resolved[0], process.execPath);
  assert.equal(resolved[1], "/pi/entry.mjs");
});

test("resolvePiCommand falls back to the pi name", () => {
  assert.deepEqual(resolvePiCommand({ platform: "linux", env: {} }), ["pi"]);
});
