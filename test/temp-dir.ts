/**
 * Shared temp-directory helper for tests.
 *
 * A test that needs a scratch directory makes one, runs its body in it and
 * removes the directory afterwards. The prefix keeps the directories of
 * separate test files apart.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDirHelpers {
  /** Run a synchronous body in a fresh temp directory. */
  withTempDir(run: (dir: string) => void): void;
  /** Run an asynchronous body in a fresh temp directory. */
  withTempDirAsync(run: (dir: string) => void | Promise<void>): Promise<void>;
}

/** Bind the temp-directory helpers to one directory prefix. */
export function tempDirHelpers(prefix: string): TempDirHelpers {
  const make = (): string => mkdtempSync(join(tmpdir(), prefix));
  const remove = (dir: string): void =>
    rmSync(dir, { recursive: true, force: true });
  return {
    withTempDir(run) {
      const dir = make();
      try {
        run(dir);
      } finally {
        remove(dir);
      }
    },
    async withTempDirAsync(run) {
      const dir = make();
      try {
        await run(dir);
      } finally {
        remove(dir);
      }
    },
  };
}
