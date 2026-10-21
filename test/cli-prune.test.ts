import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDirAsync } = tempDirHelpers("foreman-cli-prune-");

interface PruneResult {
  scratch: string;
  maxAgeDays: number;
  dryRun: boolean;
  scanned: number;
  deleted: string[];
  deletedBytes: number;
}

/** One `prune` invocation with captured stdout. */
async function runPrune(argv: string[]): Promise<{
  code: number;
  result: PruneResult;
  raw: Record<string, unknown>;
}> {
  const stdout: string[] = [];
  const code = await main(["prune", ...argv], {
    stdout: (text) => stdout.push(text),
  });
  const raw = JSON.parse(stdout.join("")) as Record<string, unknown>;
  return { code, result: raw as unknown as PruneResult, raw };
}

/** A scratch file with a given age. */
function agedFile(dir: string, name: string, ageMs: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "0123456789");
  const past = new Date(Date.now() - ageMs);
  utimesSync(path, past, past);
  return path;
}

test("prune deletes the old launcher files and reports what it did", async () => {
  await withTempDirAsync(async (dir) => {
    const scratch = join(dir, "scratch");
    const old = agedFile(scratch, "a.json", 30 * 86_400_000);
    const fresh = agedFile(scratch, "b.prompt.md", 1000);
    const { code, result } = await runPrune([
      "--scratch",
      scratch,
      "--max-age-days",
      "7",
    ]);
    assert.equal(code, 0);
    assert.equal(result.scratch, scratch);
    assert.equal(result.maxAgeDays, 7);
    assert.equal(result.dryRun, false);
    assert.equal(result.scanned, 2);
    assert.deepEqual(result.deleted, [old]);
    assert.equal(result.deletedBytes, 10);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
  });
});

test("prune --dry-run lists without deleting", async () => {
  await withTempDirAsync(async (dir) => {
    const scratch = join(dir, "scratch");
    const old = agedFile(scratch, "a.json", 30 * 86_400_000);
    const { code, result } = await runPrune([
      "--scratch",
      scratch,
      "--max-age-days",
      "7",
      "--dry-run",
    ]);
    assert.equal(code, 0);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.deleted, [old]);
    assert.equal(existsSync(old), true);
  });
});

test("prune prints no sentinel fields", async () => {
  await withTempDirAsync(async (dir) => {
    const scratch = join(dir, "scratch");
    agedFile(scratch, "a.json", 30 * 86_400_000);
    const { raw } = await runPrune(["--scratch", scratch]);
    assert.equal("sentinelScanned" in raw, false);
    assert.equal("sentinelDeleted" in raw, false);
  });
});

test("prune defaults to a week of retention", async () => {
  await withTempDirAsync(async (dir) => {
    const scratch = join(dir, "scratch");
    agedFile(scratch, "a.json", 30 * 86_400_000);
    const { result } = await runPrune(["--scratch", scratch]);
    assert.equal(result.maxAgeDays, 7);
  });
});

test("prune defaults to the foreman scratch directory", async () => {
  await withTempDirAsync(async (dir) => {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = dir;
    try {
      const { result } = await runPrune([]);
      assert.equal(result.scratch, join(dir, "foreman"));
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });
});

test("prune rejects a negative --max-age-days", async () => {
  await withTempDirAsync(async (dir) => {
    await assert.rejects(
      main(["prune", "--scratch", dir, "--max-age-days", "-1"], {
        stdout: () => {},
      }),
      /--max-age-days/,
    );
  });
});
