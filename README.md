# foreman

A Claude Code skill that lets Claude drive **pi** subagents through **tmux** —
no Luvus, no pi-task dependency, no pi extension on the parent side.

Every subagent is a pi process in its own tmux pane. The orchestrator (Claude
Code) launches children with a bundled launcher script, ends its turn, and the
child's report arrives as a new turn via `tmux send-keys`. Lifecycle runs
through `<session>.exit` sidecar files written by a small child-side pi
extension.

Status: planned. See [PLAN.md](PLAN.md) for the port plan from pi-luvus.

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

## Layout (planned)

```text
skills/foreman/SKILL.md      orchestration protocol for the Claude orchestrator
skills/foreman/launch.ts     shim/CLI entry: start, resume, wait, send, last-message, prune
src/                         CLI core (tmux-backed port of pi-luvus cli.ts/launch.ts)
extension/foreman-done/      child-side pi extension: done/handoff/ping sidecars, auto-exit, nudge
test/                        ported pi-luvus tests + tmux end-to-end checks
```

## Usage (target shape)

```bash
node <skill-dir>/launch.ts start --name <child> --role <role> --cwd <dir> \
  --brief <file> [--surface right|down|tab] [--close-grace-ms <n>]
node <skill-dir>/launch.ts resume --launch <spec> --prompt <file>
node <skill-dir>/launch.ts last-message --session <file>
```

The child reports with `launch.ts send --to <parent-pane> --text ...`
(`tmux send-keys` into the orchestrator pane; arrives as a new turn).
