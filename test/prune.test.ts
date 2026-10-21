import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoPrune,
  defaultScratchDir,
  pruneScratch,
  DEFAULT_PRUNE_MAX_AGE_DAYS,
} from "../src/prune.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("foreman-prune-");

function makeFiles(dir: string, names: string[], ageMs: number): void {
  mkdirSync(dir, { recursive: true });
  const past = new Date(Date.now() - ageMs);
  for (const name of names) {
    const path = join(dir, name);
    writeFileSync(path, "x");
    utimesSync(path, past, past);
  }
}

test("prunes every managed launcher suffix past the retention", () => {
  withTempDir((dir) => {
    const names = [
      "a.json",
      "b.jsonl",
      "c.prompt.md",
      "d.role.md",
      "e.resume.md",
      "f.exit",
      "g.msg",
      "h.report.md",
    ];
    makeFiles(dir, names, 8 * 86_400_000);
    makeFiles(dir, ["keep.prompt.md"], 1000);
    const result = pruneScratch(dir, { maxAgeMs: 7 * 86_400_000 });
    assert.equal(result.scanned, 9);
    assert.deepEqual(
      result.deleted.map((p) => p.split("/").pop()),
      names,
    );
  });
});

test("prunes a report receipt past the retention and keeps it within it", () => {
  withTempDir((dir) => {
    makeFiles(dir, ["old.sent"], 8 * 86_400_000);
    makeFiles(dir, ["fresh.sent"], 1000);
    const result = pruneScratch(dir, { maxAgeMs: 7 * 86_400_000 });
    assert.equal(result.scanned, 2);
    assert.deepEqual(
      result.deleted.map((p) => p.split("/").pop()),
      ["old.sent"],
    );
    assert.ok(existsSync(join(dir, "fresh.sent")));
  });
});

test("ignores files with unknown suffixes", () => {
  withTempDir((dir) => {
    makeFiles(dir, ["a.txt", "b.md", "c.jsonl.bak"], 30 * 86_400_000);
    const result = pruneScratch(dir, { maxAgeMs: 7 * 86_400_000 });
    assert.equal(result.scanned, 0);
    assert.deepEqual(result.deleted, []);
  });
});

test("dry-run lists without deleting", () => {
  withTempDir((dir) => {
    makeFiles(dir, ["a.json"], 30 * 86_400_000);
    const result = pruneScratch(dir, { maxAgeMs: 1000, dryRun: true });
    assert.equal(result.deleted.length, 1);
    assert.ok(existsSync(join(dir, "a.json")));
  });
});

test("a missing directory prunes to nothing", () => {
  const result = pruneScratch("/nonexistent-foreman-dir", { maxAgeMs: 1000 });
  assert.deepEqual(result, { scanned: 0, deleted: [], deletedBytes: 0 });
});

test("autoPrune never throws on a full or read-only tmp folder", () => {
  assert.doesNotThrow(() => autoPrune("/proc/foreman-non-writable"));
});

test("the retention default is a week and the scratch default is <tmp>/foreman", () => {
  assert.equal(DEFAULT_PRUNE_MAX_AGE_DAYS, 7);
  assert.ok(defaultScratchDir().endsWith("foreman"));
});
