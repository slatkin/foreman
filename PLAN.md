# Plan: foreman — Claude skill driving pi subagents via tmux

Port of pi-luvus's external-orchestrator skill off the Luvus CLI. The
consumer is a Claude Code orchestrator; every subagent is a pi process in its
own tmux pane. pi-task (hard fork) stays the pi-to-pi path and is untouched
by this plan.

## What exists today (pi-luvus, the porting source)

The skill is a thin shim (`skills/pi-luvus/launch.ts`, 103 lines) that
delegates to the extension's CLI; the real porting surface is:

| pi-luvus piece                             | Lines | Role                                        |
| ------------------------------------------ | ----- | ------------------------------------------- |
| `skills/pi-luvus/SKILL.md`                 | 157   | Orchestration protocol for the orchestrator |
| `pi-extension/luvus/cli.ts`                | 469   | start/resume/wait/last-message/prune CLI    |
| `pi-extension/luvus/launch.ts`             | 241   | Launch spec construction, role resolution   |
| `pi-extension/luvus/luvus-done.ts`         | 615   | Child-side: `luvus_done` tool, auto-exit, 5s completion nudge, `.exit` sidecar, report via `agent send` |
| pane-side run wrapper (in supervisor code)    | ~     | Executes the launch spec in the pane; prints `__SUBAGENT_DONE_<n>__`; close-on-done with grace |

Total porting surface ≈ 1.5k lines TS plus the SKILL.md rewrite.

## Vocabulary swap (the whole transport change)

| Luvus                                      | foreman / tmux                                      |
| ------------------------------------------ | --------------------------------------------------- |
| `LUVUS_ENV=1`, `$LUVUS_PANE_ID`            | `$TMUX` / `$TMUX_PANE` (always present in a pane)   |
| `luvus pane run` / `pane split --no-focus` | `tmux split-window -d` / `new-window`               |
| `luvus agent send <me> '<text>'` (report)    | `tmux send-keys -t <parent-pane> -l '<text>' Enter`   |
| `luvus agent read <child>`                   | `tmux capture-pane -p -t <pane>` (diagnostics only)   |
| `luvus wait agent-status --status done,blocked` | poll `<session>.exit` sidecar (already authoritative per pi-luvus docs) |
| `luvus pane close <P>`                       | `tmux kill-pane -t <P>`                               |
| `luvus agent name <me>` (parent naming)      | not needed — children target `$TMUX_PANE` directly    |
| `luvus_done` tool (child)                    | `foreman_done` tool (child extension)                 |
| `caller_ping`                                | `foreman_ping` (or keep the name; decide in Phase 2)  |

Sidecar types (`done` / `error` / `handoff` / `ping`), the launch spec JSON,
launch records, the sentinel line, close-on-done grace, and the 7-day prune
carry over unchanged — they are transport-agnostic.

## Phases

### Phase 1 — CLI core: spawn (start)

- [x] Scaffold: `skills/foreman/`, `src/`, `extension/foreman-done/`, `test/`.
- [x] Port `launch.ts` spec construction: role resolution (project
      `.pi/agents/` → global `~/.pi/agent/agents/` → package `agents/`),
      parent-contact footer, scratch dir, prompt-file generation.
- [x] Port the run wrapper: execute the spec in a new tmux pane
      (`split-window -d` with `--surface right|down|tab` mapping to
      `-h` / `-v` / `new-window`), name the pane (`select-pane -T`),
      print the sentinel on child exit.
- [x] `start` prints the same JSON shape (`{pane, session, launch}`) so the
      SKILL.md protocol and any existing habits survive.
- [x] Spawn test: child pi opens in the pane, runs its brief.

### Phase 2 — Child side: sidecar fidelity + report channel

- [x] Port `luvus-done.ts` → `extension/foreman-done/`: `foreman_done` tool,
      auto-exit, 5s completion nudge, `.exit` sidecar writer. Remove every
      Luvus call (status lease, notifications).
- [x] Report channel: child calls `node <skill-dir>/launch.ts send --to
      <parent-pane> --text ...` → `tmux send-keys -l ... Enter`. Atomic
      paste+Enter in one invocation, mirroring `agent send` semantics.
- [x] Decide ping naming (`foreman_ping` vs keeping `caller_ping` — the
      orchestrator prompts currently say "never caller_ping", so a rename
      avoids stale muscle memory).
- [x] Close-on-done: wrapper kills its own pane after the grace period on a
      `done`/`handoff` sidecar; `error`/`ping`/crash panes stay open.
- [x] End-to-end test: real tmux session, child pi reports into a fake
      parent pane; verify with `tmux capture-pane -e -p` (the established
      visual-check pattern).

### Phase 3 — Resume, wait, diagnostics

- [x] `resume --launch <spec> --prompt <file> [--surface]`: new pane, same
      session, launch record restored (spawn-time role record semantics).
- [x] `wait --session <file> --timeout <s>`: poll `.exit` (no Luvus lease
      TTL subtleties — the sidecar is the only signal, and it survives the
      pane being closed).
- [x] `last-message --session <file>`, `prune [--max-age-days] [--dry-run]`.
- [x] Port the relevant pi-luvus tests (launch spec, sidecar types, prune,
      shim lookup); drop the Luvus-specific ones.

### Phase 4 — SKILL.md + orchestrator cutover

- [x] Port SKILL.md: same structure (launch / waiting / while-it-runs /
      review-fix loop), tmux vocabulary, parent naming step deleted
      (`$TMUX_PANE` replaces `luvus agent name`).
- [x] Update `~/.claude/commands/pi-orchestrator.md` and
      `mbv-orchestrator.md`: skill name, report procedure (`launch.ts send`),
      resume command; campaign logic unchanged.
- [x] `~/.claude/luvus-agent-hook.sh` + its four settings.json hook entries:
      delete (pure Luvus reporting; nothing reads it once Luvus is out).
- [ ] Child agent files (`~/.pi/agent/agents/worker.md`, `scout.md`,
      `rust-worker.md`): replace the `luvus_done`/`caller_ping` ceremony with
      `foreman_done` — **only when pi-luvus retires**, since those files are
      shared with the pi-luvus path until then.
- [x] Install: `npx skills add <this-repo> -g -a claude-code`.

### Phase 5 — Prove it

- [x] Run one real OpenSpec campaign via `pi-orchestrator.md` with foreman:
      scout → worker → reviewer round-trip, one resume, one review-fix loop.
- [x] Verify close-on-done timing against the grace period and a blocked
      wait (no lost reports — the failure mode that motivated the tmux move).
- [x] Only then retire the pi-luvus skill for orchestrators (the pi-parent
      extension keeps serving pi-to-pi until the pi-task fork lands).

## Non-goals

- No pi-task dependency or integration; no pi-parent tools (`luvus_spawn`
  equivalents) — pi parents use pi-task.
- No Luvus features: status leases, notifications, pane titles beyond
  `select-pane -T`, UHP, modules.
- No bare `foreman` binary (Ruby Procfile manager owns that name).
