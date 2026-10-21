---
name: foreman
description: Delegated subagents for build, review, recon, or doc work across the rust-worker, reviewer, scout, worker, and advisor roles, each running as a pi process in its own tmux pane and reporting back by sending a report into the parent pane. Relevant to requests phrased as launching, spinning up, spawning, starting, or delegating to another agent — a review agent for a commit, a worker implementing a task, a scout mapping unfamiliar code, review-fix loops repeating until pass, or mbv-orchestrator campaign work.
---

# pi subagents via tmux

You orchestrate; every subagent is a **pi** process in its own tmux pane.
Don't use your harness's built-in subagent tool (e.g. Claude Code's Agent
tool) for these roles. Requires a tmux session (`$TMUX` and `$TMUX_PANE`
set); outside tmux this skill does not apply. If the user wants the
orchestrator to do the work itself rather than launching a separate agent — a
direct review with no agent requested — do it directly instead. The child
runs pi with the `foreman-done` extension, which gives it the `foreman_done`
and `foreman_ping` tools plus auto-exit: an `auto-exit: true` child whose
turn ends normally closes itself (writing the `.exit` sidecar); any other
child that ends a turn without calling `foreman_done` gets a 5-second
completion nudge reminding it until it does.

All launching goes through `launch.ts`, which lives next to this file. Run it
with `node <skill-dir>/launch.ts <command>`. It finds the child extension,
resolves the role, appends the parent-contact footer to your brief, splits and
names the pane, and writes a JSON launch spec that the pane-side run wrapper
executes. Never retype its steps by hand — invoke the script.

The command set is: `start`, `send`, `run`, `last-message`, `wait`, `prune`,
`resume`. `run` is the pane-side wrapper and is never called by hand.

Two channels with different jobs — do not confuse them:

- **Wake-up / report** = `node <cli> send --to <parent-pane> --text '<text>'`,
  run by the child. It types the text into your pane and submits it, so it
  arrives as a new turn. This is the ONLY way you learn anything, because you
  cannot poll after ending your turn.
- **Lifecycle** = the `<session>.exit` sidecar file, written by
  `foreman_done` (`{"type":"done"}`, `{"type":"handoff",...}`), by
  `foreman_ping` (`{"type":"ping",...}`) or by the child extension's error
  path (`{"type":"error",...}`). The pane-side wrapper prints
  `__SUBAGENT_DONE_<exit code>__` when the child exits, and closes its own
  pane only on a `done` or `handoff` sidecar, after a grace period (5000 ms
  by default, set per launch with `--close-grace-ms`). The sidecar survives
  the pane being closed, which is what makes it the authoritative signal.

Role definitions resolve in this order: the project's `.pi/agents/`, then
the global `~/.pi/agent/agents/`, then the package's own `agents/`.
Current roles: `rust-worker` (code), `reviewer`
(bounded review), `scout` (recon), `worker` (docs / rote), `advisor` (only
with user consent).

## Where the CLI lives

`<skill-dir>` is the directory holding this SKILL.md. The shim finds the
foreman package at run time: `PI_FOREMAN_DIR` if it is set, else the checkout
that holds the shim (this file lives at `<root>/skills/foreman/launch.ts`).
When the skill is installed by copy — `npx skills add` copies the files —
the checkout is no longer next to the shim, and the shim then has to be told
where the package is. Two ways, in order of preference:

1. Point the installed shim back at the checkout (one symlink, no
   environment variable, works for every agent that reads the skill dir):
   ```bash
   rm ~/.claude/skills/foreman/launch.ts
   ln -s /path/to/foreman/skills/foreman/launch.ts ~/.claude/skills/foreman/launch.ts
   ```
   The shim resolves its own real path, so the checkout is found again.
   Re-do this after every `skills add` / `skills update`, which copies the
   shim back.
2. Set `PI_FOREMAN_DIR` in the environment of the orchestrator:
   ```bash
   export PI_FOREMAN_DIR=/path/to/foreman
   node ~/.claude/skills/foreman/launch.ts help
   ```

Check the install with `help`, which prints the authoritative command set;
everything below matches it.

## Launch

0. Your own pane id is `$TMUX_PANE` — it is always set inside a pane, and it
   is what children send their reports to. There is no naming step and no
   name to pass: every child gets `--parent "$TMUX_PANE"`.
1. Write the brief to a file — the task, nothing else. The launcher
   appends the parent-contact footer (your pane id and the report
   procedure) itself.
2. Start the child:
   ```bash
   node <skill-dir>/launch.ts start --name <child> --role <role> --cwd <dir> --brief <file> --parent "$TMUX_PANE" [--scratch <dir>] [--close-grace-ms <n>] [--surface right|down|tab]
   ```
   `<cwd>` is the child's working directory; `--scratch` (default
   `${TMPDIR:-/tmp}/foreman`) holds the generated prompt, role prompt and
   launch spec. Each `start` deletes scratch files older than 7 days, so the
   folder stays bounded; recent sessions stay for resume. To clean on demand
   (add `--dry-run` to only list):
   ```bash
   node <skill-dir>/launch.ts prune [--scratch <dir>] [--max-age-days <n>] [--dry-run]
   ```
   `--surface` places the new pane: `right` (the default) splits yours side
   by side, `down` stacks it below, `tab` gives it its own tmux window. On
   success it prints JSON on stdout: `{"pane":..., "session":..., "launch":...}`.
   `session` is the child's session file (the sidecar lives next to it),
   `launch` is the launch-spec path a resume needs, and `pane` is the child's
   pane id — it matters only while the child is alive, because a `done`
   child closes its own pane after the close grace.
3. End the turn. The report arrives as a new message in your prompt — that
   is the child running the `send` command from its footer. Do NOT sit in a
   polling loop on `<session>.exit` instead of ending your turn; the wake-up
   is the message, not the file.
4. When you are awake again (the report arrived, or you want the child's
   final state), wait for the sidecar and read it:

   ```bash
   node <skill-dir>/launch.ts wait --session <session> [--timeout <seconds>]
   ```

   `wait` blocks until the sidecar appears (default timeout 600 s). On
   success it prints one JSON line and exits 0:
   `{"reason":"done","exitCode":0,"sidecar":"/abs/path/<session>.exit"}`.
   `reason` is one of `done`, `handoff`, `ping`, `error`. A timeout prints
   `{"sidecar":null}` and exits 2 (a child may simply still be working — wait
   again, or nudge it); a usage error exits 1 and prints nothing on stdout.
   `wait` never deletes the sidecar, and neither should you: the pane-side
   wrapper reads the same file after the child exits, so removing it early
   leaves the wrapper blind — it cannot close the pane, and the ping
   wake-up loses the question. Read the JSON and act on it, but LEAVE the
   sidecar in place; it is cleaned up for you:

   - `start` and `resume` clear the sidecar of the session they (re)launch,
     so a fresh run never reads an earlier run's exit.
   - `prune` reclaims `.exit` files once they fall outside the retention
     window.
   - A repeated `wait` on the same session re-reports the same exit, which
     is harmless.

   The `sidecar` field of the printed JSON is that absolute path.

5. Act on the reason from the wait JSON:
   - `done` → clean finish. The child sent its report and closed itself;
     the pane has closed after the close grace.
   - `handoff` → the child ended cleanly at its context alert, but the task
     is NOT complete. The handoff text a fresh agent needs is in the JSON
     (`handoff.message`). The pane closes itself after the close grace, like
     a `done` pane. Do NOT resume that session: start a NEW child with
     `start` and put the handoff text in its brief.
   - `error` → provider failure — auto-retry exhausted, no report was sent.
     The pane stays open showing `__SUBAGENT_DONE_<n>__`; read the last
     assistant message from the session file per step 6, then retry or
     resume, and close the pane once you are done with it.
   - `ping` → the child called `foreman_ping` instead of sending a report.
     The question is in the JSON (`ping.message`) and in the wake-up text
     the wrapper sent you. Answer it with a `resume` (see below). The pane
     stays open until you close it.
   - No sidecar at all (timeout) and `__SUBAGENT_DONE_<n>__` at the tail of
     the child's pane → the wrapper itself was killed, so the child wrote no
     sidecar. The pane stays open. Read the last assistant message from the
     session file (step 6) and decide whether to relaunch, then close the
     pane once you are done with it.
6. Cross-check the report against the child's last assistant message in the
   session file from the start JSON:
   ```bash
   node <skill-dir>/launch.ts last-message --session <session>
   ```
   It prints the text of the session's last assistant message, or
   `(no assistant message)`.

## While it runs / after

- A follow-up (a recheck, or the answer to the child's question) always
  runs in a **new** pane: write the follow-up to a prompt file and run
  (`resume` clears the stale `.exit` sidecar of the session it relaunches):
  ```bash
  node <skill-dir>/launch.ts resume --launch <spec> --prompt <file> [--name <child>] [--surface right|down|tab]
  ```
  `<spec>` is the `launch` field from the start JSON; `--name` defaults to
  the child name stored in the spec. The same session resumes with full
  context and the child re-reports the same way — the launcher re-appends
  the parent-contact footer to the prompt, so the resumed child still knows
  how to reach you. The old pane is not needed. A fresh role or a correction
  lane → new child via `start`.
- Idle child (you expected a report long ago): type a nudge into the
  child's pane and press Enter, using the pane id from the `pane` field of
  the start JSON:
  ```bash
  tmux send-keys -t <pane> -l "status? Send your report with the send command from your brief, then call foreman_done"
  tmux send-keys -t <pane> Enter
  ```
  The child extension's own 5-second nudge handles the common
  forgot-to-exit case; this one handles a silent stall.
- Close the pane only for `error`, `ping` and crash panes once you are done
  with them: `tmux kill-pane -t <pane>`. A `done` or `handoff` pane closes
  itself after the close grace — there is nothing to close. Never close
  panes you didn't create.
- One writer per worktree at a time; read-only roles may run in parallel.

## Review-fix loop

For "review this commit, fix the findings, repeat until pass": launch one
`reviewer` child with `node <skill-dir>/launch.ts start`. Each round: assess
the returned findings yourself, apply the fixes (or delegate them to a
`worker` child), commit, then write a `review <SHA>` follow-up prompt and run
`node <skill-dir>/launch.ts resume` with it. The resumed session keeps context
across rounds, so it can verify its earlier findings are actually addressed.
When it reports pass, ship.
