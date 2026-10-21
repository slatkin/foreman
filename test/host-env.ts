/**
 * Clear the terminal-host variables for the test process.
 *
 * The suite must never talk to a real multiplexer. A run inside a tmux pane
 * inherits the host keys, and an un-stubbed backend call would then mutate
 * real panes — including closing the pane that runs the suite. Every test
 * file that exercises a backend imports this module first.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("LUVUS_") ||
    key.startsWith("PI_LUVUS_") ||
    key.startsWith("PI_PMUX_") ||
    key.startsWith("PI_FOREMAN_") ||
    key === "TMUX" ||
    key === "TMUX_PANE"
  ) {
    delete process.env[key];
  }
}

/**
 * The role resolution reads the agent config directory. A suite run on a
 * machine with real agent files would pick them up and change what the tests
 * see. Give the process its own agent config directory: empty, and removed
 * when the process ends.
 */
const agentConfigDir = mkdtempSync(join(tmpdir(), "foreman-test-"));
process.env.PI_CODING_AGENT_DIR = agentConfigDir;
process.on("exit", () => {
  rmSync(agentConfigDir, { recursive: true, force: true });
});
