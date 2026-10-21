# Quickstart

## What it is

foreman is a Claude Code skill that lets Claude drive **pi** subagents through
**tmux**. Every subagent is a pi process in its own tmux pane; the
orchestrator launches it with a launcher script, ends its turn, and the
child's report arrives as a new turn typed into the orchestrator's pane.
Lifecycle runs through `<session>.exit` sidecar files.

## Prerequisites

- tmux, with the orchestrator running inside a pane (`$TMUX` and `$TMUX_PANE`
  must be set — every launch checks).
- node >= 22.18, which runs `.ts` files without a flag (the pane side needs
  this).
- pi installed and on PATH.
- At least one role definition: a Markdown file with frontmatter and a
  `model:` line, found in `<cwd>/.pi/agents/`, then `~/.pi/agent/agents/`,
  then the foreman package's own `agents/`.

## Install

```bash
npx skills add /home/slatkin/Dev/foreman -g -a claude-code
```

The install copies `skills/foreman/` into `~/.claude/skills/foreman/`, so the
copied shim can no longer find the package by walking up from its own path.
Point it back at the checkout with one symlink:

```bash
rm ~/.claude/skills/foreman/launch.ts
ln -s /home/slatkin/Dev/foreman/skills/foreman/launch.ts ~/.claude/skills/foreman/launch.ts
```

Re-do it after every `skills add` / `skills update`, which copies the shim
back. The alternative is the `PI_FOREMAN_DIR` environment variable:

```bash
export PI_FOREMAN_DIR=/home/slatkin/Dev/foreman
```

Verify either way:

```bash
node ~/.claude/skills/foreman/launch.ts help
```

It prints the authoritative command set. There is no bare `foreman` binary —
that name belongs to the Ruby Procfile manager — so invoke everything as
`node <skill-dir>/launch.ts <command>`.

## Launch your first subagent

1. Write the brief to a file — the task, nothing else. The launcher appends
   the parent-contact footer itself.

   ```bash
   cat > /tmp/task-brief.md <<'EOF'
   Write docs/quickstart.md in /home/slatkin/Dev/foreman. Commit it.
   EOF
   ```

2. Start the child:

   ```bash
   node ~/.claude/skills/foreman/launch.ts start \
     --name docs-worker \
     --role worker \
     --cwd /home/slatkin/Dev/foreman \
     --brief /tmp/task-brief.md \
     --parent "$TMUX_PANE"
   ```

3. On success it prints one JSON line:

   ```json
   {"pane":"%12","session":"/tmp/foreman/docs-worker-1a2b3c4d.jsonl","launch":"/tmp/foreman/docs-worker-1a2b3c4d.json"}
   ```

   - `pane` — the child's pane id; it matters only while the child is alive,
     because a `done` child closes its own pane after the close grace.
   - `session` — the child's session file; the sidecar lives next to it
     (`<session>.exit`).
   - `launch` — the launch-spec path a later `resume` needs.

   `--surface right|down|tab` places the new pane (`right`, the default,
   splits yours side by side). `--scratch <dir>` overrides the scratch
   directory, which defaults to `${TMPDIR:-/tmp}/foreman`. The scratch
   directory holds the generated prompt, role prompt, launch spec, session
   file and later sidecars.

4. End your turn. The report arrives as a new message in your prompt.

## What the child does

The launcher appends a footer to your brief before the child ever sees it.
The footer teaches the child everything it needs: it types its report into
your pane with `node <cli-path> send --to <your-pane> --text '<text>'`, then
calls the `foreman_done` tool to close its own session; if it is blocked, it
sends its question and stops. One-line summary: the child reports with `send`,
closes with `foreman_done`, and asks instead of guessing.

## Waiting for it

After the report arrives (or when you want the child's final state), wait for
the sidecar:

```bash
node ~/.claude/skills/foreman/launch.ts wait --session /tmp/foreman/docs-worker-1a2b3c4d.jsonl --timeout 600
```

Success prints one JSON line and exits 0:

```json
{"reason":"done","exitCode":0,"sidecar":"/tmp/foreman/docs-worker-1a2b3c4d.jsonl.exit"}
```

A timeout prints `{"sidecar":null}` on stdout, a message on stderr, and exits
2 — a child may simply still be working, so wait again or nudge it. A usage
error exits 1 and prints nothing on stdout.

The `reason` field is the interpreted sidecar payload:

| reason | exitCode | extra fields | meaning |
| --- | --- | --- | --- |
| `done` | 0 | — | clean finish; the pane closes itself after the close grace (5000 ms by default, set per launch with `--close-grace-ms`) |
| `handoff` | 0 | `handoff.message` | clean stop at a context alert, task NOT complete; start a NEW child with the handoff text in its brief — do not resume |
| `ping` | 0 | `ping.name`, `ping.message` | the child called `foreman_ping` with a question; answer it with a `resume`; the pane stays open |
| `error` | 1 | `errorMessage` (plus `errorSource` when present) | provider failure, auto-retry exhausted, no report was sent; the pane stays open |

An unknown or malformed sidecar interprets as `done`.

**Leave the sidecar in place.** `wait` never removes it, and neither should
you: the pane-side wrapper reads the same file after the child exits, to close
the pane on `done`/`handoff` and to quote a ping in the no-report wake-up.
Removing it early leaves the wrapper blind. Cleanup is handled for you:
`start` and `resume` clear the sidecar of the session they (re)launch, and
`prune` reclaims `.exit` files after the retention window. A repeated `wait`
on the same session re-reports the same exit, which is harmless.

## Resume

A follow-up (a recheck, a correction, or the answer to a child's question)
always runs in a **new** pane, resuming the same session with full context:

```bash
node ~/.claude/skills/foreman/launch.ts resume \
  --launch /tmp/foreman/docs-worker-1a2b3c4d.json \
  --prompt /tmp/follow-up.md
```

`--launch` is the `launch` field from the start JSON; `--name` defaults to the
child name stored in the spec, and `--surface` places the new pane as in
`start`. The launcher re-appends the parent-contact footer to the prompt, so
the resumed child still knows how to report. It prints
`{"pane":...,"launch":...}` and clears the stale sidecar of the session it
relaunches. The old pane is not needed; a fresh role or a new task gets a new
child via `start` instead.

To cross-check a report against the child's last assistant message:

```bash
node ~/.claude/skills/foreman/launch.ts last-message --session <session>
```

## Housekeeping (prune)

Every `start` auto-prunes scratch files older than 7 days, so the folder stays
bounded. To clean on demand:

```bash
node ~/.claude/skills/foreman/launch.ts prune [--scratch <dir>] [--max-age-days 7] [--dry-run]
```

`--dry-run` lists without deleting. It prints one JSON line with what it
scanned and deleted. Only launcher-owned files (`.json`, `.jsonl`,
`.prompt.md`, `.role.md`, `.resume.md`, `.exit`, `.msg`, `.report.md`) are
considered; fresh files stay so running children and recent resumes keep
working.

## Troubleshooting

**`cli.ts: must run inside a tmux pane (TMUX and TMUX_PANE must be set)`**
The orchestrator is not running inside a tmux pane. Start tmux, work inside a
pane, and launch again.

**`cli.ts: unknown role '<role>' (searched: ...)`**
No role file was found in `<cwd>/.pi/agents/<role>.md`,
`~/.pi/agent/agents/<role>.md`, or the package's `agents/<role>.md`. Create
the role file with the required frontmatter — it must carry a `model:` line,
or the launch fails with `role '<role>' has an empty model`.

**`Cannot find the foreman package (no src/cli.ts and extension/foreman-done/index.ts in: ...)`**
The shim cannot locate the checkout. This is the copy-install problem from
[Install](#install): either symlink the shim back to the checkout, or set
`PI_FOREMAN_DIR` to the checkout path. Verify with
`node ~/.claude/skills/foreman/launch.ts help`.

**`cli.ts: node >= 22.18 is required (running 20.x.y)`**
Upgrade node. The pane-side entry runs a `.ts` file directly, which needs
node 22.18 or newer.
