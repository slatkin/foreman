---
name: foreman
description: Orchestration protocol for driving pi subagents in tmux panes (launch, wait, resume, review-fix loops). Stub — the protocol is ported from pi-luvus in Phase 4 of PLAN.md.
---

# foreman (stub)

The orchestration protocol (launch / waiting / while-it-runs / review-fix loop) is ported
from pi-luvus in Phase 4 of `PLAN.md`. Until then this skill is not installed anywhere
and must not be invoked.

The CLI shim next to this file already works for manual testing from a checkout:

```
node skills/foreman/launch.ts start --name <child> --role <role> --cwd <dir> \
  --brief <file> --parent "$TMUX_PANE"
```
