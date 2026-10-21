import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { __setTmuxExecForTests__ } from "../src/tmux.ts";
import { main } from "../src/cli.ts";
import { useTmuxPaneFake } from "./tmux-fakes.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDirAsync } = tempDirHelpers("foreman-cli-");

const HOST_ENV = { TMUX: "/tmp/tmux-0/x,1,0", TMUX_PANE: "%1" };

/** A minimal role definition with a model, written into the project's .pi/agents. */
function writeRole(dir: string, body = "You are a scout."): string {
  mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
  const rolePath = join(dir, ".pi", "agents", "scout.md");
  writeFileSync(
    rolePath,
    `---\nname: scout\ndescription: explores\nmodel: claude-sonnet-4\n---\n${body}\n`,
  );
  return rolePath;
}

interface StartFixture {
  cwd: string;
  scratch: string;
  brief: string;
}

function startFixture(dir: string): StartFixture {
  const cwd = join(dir, "repo");
  const scratch = join(dir, "scratch");
  mkdirSync(cwd, { recursive: true });
  writeRole(cwd);
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "Map the module.\n");
  return { cwd, scratch, brief };
}

interface StartArgs {
  cwd: string;
  scratch: string;
  brief: string;
  name?: string;
  surface?: string;
  parent?: string;
  env?: NodeJS.ProcessEnv;
}

function startArgv(fx: StartArgs): string[] {
  const argv = [
    "start",
    "--name",
    fx.name ?? "Scout One",
    "--role",
    "scout",
    "--cwd",
    fx.cwd,
    "--brief",
    fx.brief,
    "--parent",
    fx.parent ?? "%1",
  ];
  if (fx.scratch !== undefined) argv.push("--scratch", fx.scratch);
  if (fx.surface !== undefined) argv.push("--surface", fx.surface);
  return argv;
}

test("start resolves the role, writes the files and spawns the pane", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = startFixture(dir);
    const fake = useTmuxPaneFake();
    let out = "";
    const code = await main(startArgv({ ...fx, scratch: fx.scratch }), {
      env: HOST_ENV,
      stdout: (t) => (out += t),
    });
    assert.equal(code, 0);

    const printed = JSON.parse(out) as {
      pane: string;
      session: string;
      launch: string;
    };
    assert.equal(printed.pane, "%24");
    assert.ok(printed.session.endsWith(".jsonl"));
    assert.ok(printed.launch.endsWith(".json"));

    // The pane got the launch line, pasted literally, then Enter.
    assert.match(fake.lines[0], /^split-window -d -h -t %1 /);
    assert.match(fake.lines[1], /^select-pane -t %24 -T /);
    assert.match(
      fake.lines[2],
      /^send-keys -t %24 -l node ".*cli\.ts" "run" ".*\.json" ".*\.prompt\.md"$/,
    );
    assert.equal(fake.lines[3], "send-keys -t %24 Enter");

    // The spec carries the child contract.
    const spec = JSON.parse(readFileSync(printed.launch, "utf8"));
    assert.equal(spec.version, 1);
    assert.equal(spec.command, "pi");
    assert.equal(spec.parent, "%1");
    assert.equal(spec.env.PI_FOREMAN_SESSION, printed.session);
    assert.equal(spec.env.PI_FOREMAN_NAME, "Scout One");
    assert.deepEqual(spec.closeOnDone, { graceMs: 5000 });
    const extension = spec.args[spec.args.indexOf("-e") + 1] as string;
    assert.ok(extension.endsWith("foreman-done/index.ts"));
    assert.ok(spec.args.includes("claude-sonnet-4"));
    const tools = spec.args[spec.args.indexOf("--tools") + 1] as string;
    assert.ok(tools.split(",").includes("foreman_done"));

    // The prompt carries the brief plus the parent-contact footer, and the
    // footer teaches the send command with the real CLI path.
    const prompt = readFileSync(
      printed.session.replace(".jsonl", ".prompt.md"),
      "utf8",
    );
    assert.match(prompt, /Map the module\./);
    assert.match(prompt, /send --to %1 --text '<text>'/);
    assert.match(prompt, /foreman_done/);

    // The role body lands in its own file.
    const rolePrompt = readFileSync(
      printed.session.replace(".jsonl", ".role.md"),
      "utf8",
    );
    assert.match(rolePrompt, /You are a scout\./);
    __setTmuxExecForTests__(null);
  });
});

test("start honours --surface down and tab", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = startFixture(dir);

    const down = useTmuxPaneFake();
    await main(startArgv({ ...fx, name: "s", surface: "down" }), {
      env: HOST_ENV,
      stdout: () => {},
    });
    assert.match(down.lines[0], /^split-window -d -v -t %1 /);
    __setTmuxExecForTests__(null);

    const tab = useTmuxPaneFake();
    await main(startArgv({ ...fx, name: "s2", surface: "tab" }), {
      env: HOST_ENV,
      stdout: () => {},
    });
    assert.match(tab.lines[0], /^display-message -p -t %1 #\{session_id\}$/);
    assert.match(tab.lines[1], /^new-window -d -t \$7 /);
    __setTmuxExecForTests__(null);
  });
});

test("start rejects an invalid --surface value without spawning", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = startFixture(dir);
    let err = "";
    const code = await main(startArgv({ ...fx, name: "s", surface: "float" }), {
      env: HOST_ENV,
      stdout: () => {},
      stderr: (t) => (err += t),
    });
    assert.equal(code, 2);
    assert.match(err, /invalid --surface value/);
  });
});

test("start refuses to run outside tmux", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = startFixture(dir);
    await assert.rejects(
      main(startArgv({ ...fx, scratch: fx.scratch }), {
        env: {},
        stdout: () => {},
      }),
      /must run inside a tmux pane/,
    );
  });
});

test("start rejects an unknown role and a role without a model", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = startFixture(dir);
    const argv = (role: string): string[] => [
      "start",
      "--name",
      "s",
      "--role",
      role,
      "--cwd",
      fx.cwd,
      "--brief",
      fx.brief,
      "--parent",
      "%1",
      "--scratch",
      fx.scratch,
    ];
    await assert.rejects(
      main(argv("nobody"), { env: HOST_ENV, stdout: () => {} }),
      /unknown role 'nobody'/,
    );

    const roleDir = join(dir, "repo", ".pi", "agents");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(
      join(roleDir, "nomodel.md"),
      "---\nname: nomodel\n---\nBody.",
    );
    await assert.rejects(
      main(argv("nomodel"), { env: HOST_ENV, stdout: () => {} }),
      /empty model/,
    );
  });
});

test("start validates the pane command line before creating anything", async () => {
  await withTempDirAsync(async (dir) => {
    const fx = startFixture(dir);
    useTmuxPaneFake();
    // A scratch path with `$` makes the pane line unsafe, and no scratch file
    // may be created for it.
    const badScratch = join(dir, "sc$ratch");
    await assert.rejects(
      main(startArgv({ ...fx, name: "s", scratch: badScratch }), {
        env: HOST_ENV,
        stdout: () => {},
      }),
      /Unsafe pane command token/,
    );
    __setTmuxExecForTests__(null);
  });
});
