# foreman

A Claude Code skill that lets Claude drive **pi** subagents through **tmux** —
no Luvus, no pi-task dependency, no pi extension on the parent side.

Every subagent is a pi process in its own tmux pane. The orchestrator (Claude
Code) launches children with a bundled launcher script, ends its turn, and the
child's report arrives as a new turn, typed into the orchestrator's pane by
`tmux send-keys`. Lifecycle runs through `<session>.exit` sidecar files written
by a small child-side pi extension.

## Why

- tmux pane management is mature; Luvus's is young (see the 2026-10-20
  evaluation that motivated this repo).
- pi-task covers pi-to-pi delegation over tmux natively; foreman covers the
  remaining case: a **Claude Code orchestrator** driving **pi** children.
- pi-luvus bundles this as one "god extension" tied to Luvus. foreman is the
  external-orchestrator piece alone, off the Luvus CLI.

## Design constraints

- **No bare `foreman` binary on PATH** — that name belongs to the Ruby
  Procfile manager. Invoke everything as `node <skill-dir>/launch.ts ...`.
- Self-contained scripts (Node builtins only), so `npx skills add` copies
  stay portable — same pattern as the pi-luvus skill shim.
- Works with stock pi; independent of the pi-task fork.
- MIT; derives from pi-luvus (itself descended from
  [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)).

## Layout

```text
skills/foreman/SKILL.md      orchestration protocol for the Claude orchestrator
skills/foreman/launch.ts     shim/CLI entry: start, send, run, last-message, wait, prune, resume
src/                         CLI core (tmux-backed port of pi-luvus cli.ts/launch.ts)
  cli.ts                     subcommand dispatch and the authoritative usage text
  launch.ts                  launch-spec construction, prompt/footer generation
  tmux.ts                    the only terminal host: split, name, send, close
  placement.ts               surface placement: right | down | tab
  run.ts                     pane-side run wrapper: sentinel, wake-up, close-on-done
  exit-sidecar.ts            the .exit sidecar protocol (done/handoff/ping/error)
  session.ts                 session-file reading (last assistant message)
  agent-defs.ts              role resolution and the child tool allowlist
  child-env.ts               the child environment block
  prune.ts                   scratch retention
extension/foreman-done/      child-side pi extension: done/handoff/ping sidecars, auto-exit, nudge
test/                        ported pi-luvus tests + tmux end-to-end checks
```

## Commands

```bash
node <skill-dir>/launch.ts start --name <child> --role <role> --cwd <dir> \
  --brief <file> --parent "$TMUX_PANE" [--scratch <dir>] [--close-grace-ms <n>] \
  [--surface right|down|tab]
node <skill-dir>/launch.ts resume --launch <spec> --prompt <file> [--name <child>]
node <skill-dir>/launch.ts wait --session <file> [--timeout <seconds>]
node <skill-dir>/launch.ts send --to <pane> --text <text>
node <skill-dir>/launch.ts last-message --session <file>
node <skill-dir>/launch.ts prune [--scratch <dir>] [--max-age-days <n>] [--dry-run]
```

`start` prints `{"pane":..., "session":..., "launch":...}`. `wait` prints one
JSON line with the sidecar result and the sidecar's absolute path; it never
removes the file (the pane-side wrapper reads the same file after the child
exits), so the parent removes it after it has handled the result.

The child reports with `launch.ts send --to <parent-pane> --text ...`
(`tmux send-keys` into the orchestrator pane; arrives as a new turn), then
calls the `foreman_done` tool to close its own session.

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
node ~/.claude/skills/foreman/launch.ts help
```

## Development

```bash
pnpm install
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test
```

The port plan from pi-luvus lives in [PLAN.md](PLAN.md).
