import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { __setTmuxExecForTests__ } from "../src/tmux.ts";
import { main } from "../src/cli.ts";
import { LAUNCH_SPEC_VERSION, writeLaunchSpec } from "../src/launch.ts";
import { useTmuxPaneFake } from "./tmux-fakes.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDirAsync } = tempDirHelpers("foreman-resume-");

const HOST_ENV = { TMUX: "/tmp/tmux-0/x,1,0", TMUX_PANE: "%1" };

interface Fixture {
  specPath: string;
  sessionFile: string;
  promptPath: string;
}

/** A launch spec with a parent, plus the follow-up prompt file. */
function fixture(dir: string): Fixture {
  const scratch = join(dir, "scratch");
  mkdirSync(scratch, { recursive: true });
  const sessionFile = join(scratch, "worker-1.jsonl");
  const specPath = join(scratch, "worker-1.json");
  writeLaunchSpec(specPath, {
    version: LAUNCH_SPEC_VERSION,
    name: "worker",
    cwd: dir,
    env: { PI_FOREMAN_NAME: "worker" },
    command: "pi",
    args: ["--session", sessionFile, "--name", "worker"],
    sessionFile,
    title: "worker — first task",
    closeOnDone: { graceMs: 5000 },
    parent: "%1",
  });
  const promptPath = join(scratch, "followup.md");
  writeFileSync(promptPath, "Now fix the failing test.\n");
  return { specPath, sessionFile, promptPath };
}

test("resume reuses the session, appends the footer and prints pane and launch", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = fixture(dir);
    const fake = useTmuxPaneFake();
    let out = "";
    const code = await main(
      ["resume", "--launch", fx.specPath, "--prompt", fx.promptPath],
      { env: HOST_ENV, stdout: (t) => (out += t) },
    );
    assert.equal(code, 0);

    const printed = JSON.parse(out) as { pane: string; launch: string };
    assert.equal(printed.pane, "%24");
    assert.equal(printed.launch, fx.specPath);
    // pmux's shape: a resume prints the pane and the spec, no session key.
    assert.deepEqual(Object.keys(printed).sort(), ["launch", "pane"]);

    // The prompt got the parent-contact footer again, next to the follow-up
    // text, and the pane runs the spec with that prompt.
    const sentPrompt = `${fx.promptPath}.resume.md`;
    const prompt = readFileSync(sentPrompt, "utf8");
    assert.match(prompt, /Now fix the failing test\./);
    assert.match(prompt, /send --to %1 --text '<text>'/);
    assert.match(prompt, /foreman_done/);
    assert.match(
      fake.lines[2],
      /^send-keys -t %24 -l node ".*cli\.ts" "run" ".*worker-1\.json" ".*followup\.md\.resume\.md"$/,
    );
    assert.equal(fake.lines[3], "send-keys -t %24 Enter");

    // The spec is reused unchanged: the same session file, the same name.
    const spec = JSON.parse(readFileSync(fx.specPath, "utf8"));
    assert.equal(spec.sessionFile, fx.sessionFile);
    assert.equal(spec.name, "worker");
    assert.match(fake.lines[1], /^select-pane -t %24 -T worker$/);
    __setTmuxExecForTests__(null);
  });
});

test("resume names the pane after --name when it is given", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = fixture(dir);
    const fake = useTmuxPaneFake();
    const code = await main(
      [
        "resume",
        "--launch",
        fx.specPath,
        "--prompt",
        fx.promptPath,
        "--name",
        "fix-7",
      ],
      { env: HOST_ENV, stdout: () => {} },
    );
    assert.equal(code, 0);
    assert.match(fake.lines[1], /^select-pane -t %24 -T fix-7$/);
    __setTmuxExecForTests__(null);
  });
});

test("resume removes the sidecar of the earlier run", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = fixture(dir);
    const sidecar = `${fx.sessionFile}.exit`;
    writeFileSync(sidecar, JSON.stringify({ type: "done" }));
    useTmuxPaneFake();
    const code = await main(
      ["resume", "--launch", fx.specPath, "--prompt", fx.promptPath],
      { env: HOST_ENV, stdout: () => {} },
    );
    assert.equal(code, 0);
    // The new run must not read the old exit.
    assert.equal(existsSync(sidecar), false);
    __setTmuxExecForTests__(null);
  });
});

test("resume honours --surface down and tab", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = fixture(dir);

    const down = useTmuxPaneFake();
    await main(
      [
        "resume",
        "--launch",
        fx.specPath,
        "--prompt",
        fx.promptPath,
        "--surface",
        "down",
      ],
      { env: HOST_ENV, stdout: () => {} },
    );
    assert.match(down.lines[0], /^split-window -d -v -t %1 /);
    __setTmuxExecForTests__(null);

    const tab = useTmuxPaneFake();
    await main(
      [
        "resume",
        "--launch",
        fx.specPath,
        "--prompt",
        fx.promptPath,
        "--surface",
        "tab",
      ],
      { env: HOST_ENV, stdout: () => {} },
    );
    assert.match(tab.lines[0], /^display-message -p -t %1 #\{session_id\}$/);
    assert.match(tab.lines[1], /^new-window -d -t \$7 /);
    __setTmuxExecForTests__(null);
  });
});

test("resume refuses to run outside tmux", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = fixture(dir);
    await assert.rejects(
      main(["resume", "--launch", fx.specPath, "--prompt", fx.promptPath], {
        env: {},
        stdout: () => {},
      }),
      /must run inside a tmux pane/,
    );
    // Nothing was written and no pane was created.
    assert.equal(existsSync(`${fx.promptPath}.resume.md`), false);
  });
});

test("resume rejects an invalid --surface value without spawning", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = fixture(dir);
    const fake = useTmuxPaneFake();
    let err = "";
    const code = await main(
      [
        "resume",
        "--launch",
        fx.specPath,
        "--prompt",
        fx.promptPath,
        "--surface",
        "float",
      ],
      { env: HOST_ENV, stdout: () => {}, stderr: (t) => (err += t) },
    );
    assert.equal(code, 2);
    assert.match(err, /invalid --surface value/);
    assert.deepEqual(fake.lines, []);
    __setTmuxExecForTests__(null);
  });
});

test("resume requires --launch and --prompt", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = fixture(dir);
    await assert.rejects(
      main(["resume", "--prompt", fx.promptPath], {
        env: HOST_ENV,
        stdout: () => {},
      }),
      /missing --launch/,
    );
    await assert.rejects(
      main(["resume", "--launch", fx.specPath], {
        env: HOST_ENV,
        stdout: () => {},
      }),
      /missing --prompt/,
    );
  });
});

test("resume rejects a missing launch spec or prompt file", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = fixture(dir);
    await assert.rejects(
      main(
        [
          "resume",
          "--launch",
          join(dir, "nope.json"),
          "--prompt",
          fx.promptPath,
        ],
        { env: HOST_ENV, stdout: () => {} },
      ),
      /launch spec is not a file/,
    );
    await assert.rejects(
      main(
        ["resume", "--launch", fx.specPath, "--prompt", join(dir, "nope.md")],
        { env: HOST_ENV, stdout: () => {} },
      ),
      /prompt is not a file/,
    );
  });
});
