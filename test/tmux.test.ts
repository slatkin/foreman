import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __setTmuxExecForTests__,
  callerPaneId,
  closeSurface,
  createSurface,
  isTmuxAvailable,
  namePane,
  runInPane,
  sendToPane,
} from "../src/tmux.ts";
import { useTmuxPaneFake } from "./tmux-fakes.ts";

test("isTmuxAvailable requires both TMUX and TMUX_PANE", () => {
  assert.equal(isTmuxAvailable({}), false);
  assert.equal(isTmuxAvailable({ TMUX: "/tmp/tmux-0/x,1,0" }), false);
  assert.equal(
    isTmuxAvailable({ TMUX: "/tmp/tmux-0/x,1,0", TMUX_PANE: "%3" }),
    true,
  );
});

test("callerPaneId reads TMUX_PANE and refuses to guess", () => {
  assert.equal(callerPaneId({ TMUX_PANE: "%3" }), "%3");
  assert.throws(() => callerPaneId({}), /TMUX_PANE is not set/);
});

test("right placement splits the caller side by side, unfocused", () => {
  const fake = useTmuxPaneFake();
  const pane = createSurface("scout", "right", "%1");
  assert.equal(pane, "%24");
  assert.deepEqual(fake.lines, [
    "split-window -d -h -t %1 -P -F #{pane_id}",
    "select-pane -t %24 -T scout",
  ]);
  __setTmuxExecForTests__(null);
});

test("down placement splits the caller stacked", () => {
  const fake = useTmuxPaneFake();
  createSurface("scout", "down", "%1");
  assert.match(fake.lines[0], /^split-window -d -v -t %1 /);
  __setTmuxExecForTests__(null);
});

test("tab placement opens a new window in the caller's session and restores focus", () => {
  const fake = useTmuxPaneFake();
  createSurface("scout", "tab", "%1");
  assert.deepEqual(fake.lines, [
    "display-message -p -t %1 #{session_id}",
    "new-window -d -t $7 -P -F #{pane_id}",
    "display-message -p -t %1 #{window_id}",
    "select-window -t @4",
    "select-pane -t %24 -T scout",
  ]);
  __setTmuxExecForTests__(null);
});

test("a failed pane naming does not fail the spawn", () => {
  __setTmuxExecForTests__((args) => {
    if (args[0] === "select-pane") throw new Error("can't find pane");
    if (args[0] === "split-window") return "%24";
    return "";
  });
  assert.equal(createSurface("scout", "right", "%1"), "%24");
  __setTmuxExecForTests__(null);
});

test("createSurface refuses to run outside tmux", () => {
  assert.throws(
    () => createSurface("scout", "right", undefined),
    /TMUX_PANE is not set/,
  );
});

test("a split result without a pane id fails loudly", () => {
  __setTmuxExecForTests__((args) =>
    args[0] === "split-window" ? "garbage" : "",
  );
  assert.throws(() => createSurface("scout", "right", "%1"), /no pane id/);
  __setTmuxExecForTests__(null);
});

test("runInPane pastes the line literally and then presses Enter", () => {
  const fake = useTmuxPaneFake();
  runInPane("%24", 'node "/cli.ts" "run" "/s.json"');
  assert.deepEqual(fake.lines, [
    'send-keys -t %24 -l node "/cli.ts" "run" "/s.json"',
    "send-keys -t %24 Enter",
  ]);
  __setTmuxExecForTests__(null);
});

test("sendToPane is the same paste-plus-Enter shape, for the report channel", () => {
  const fake = useTmuxPaneFake();
  sendToPane("%3", "worker done without sending a report");
  assert.deepEqual(fake.lines, [
    "send-keys -t %3 -l worker done without sending a report",
    "send-keys -t %3 Enter",
  ]);
  __setTmuxExecForTests__(null);
});

test("closeSurface tolerates a pane that is already gone", () => {
  __setTmuxExecForTests__((args) => {
    if (args[0] === "kill-pane") throw new Error("can't find pane: %24");
    return "";
  });
  assert.doesNotThrow(() => closeSurface("%24"));
  __setTmuxExecForTests__((args) => {
    if (args[0] === "kill-pane") throw new Error("server exited unexpectedly");
    return "";
  });
  assert.throws(() => closeSurface("%24"), /server exited/);
  __setTmuxExecForTests__(null);
});

test("namePane sends the title through select-pane -T", () => {
  const fake = useTmuxPaneFake();
  namePane("%24", "worker — task");
  assert.deepEqual(fake.lines, ["select-pane -t %24 -T worker — task"]);
  __setTmuxExecForTests__(null);
});
