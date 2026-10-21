/**
 * Age-based cleanup for the temporary scratch files the launcher writes.
 *
 * `start` writes one launch spec, two prompt files, a session file and later
 * sidecars per child under `<tmp>/foreman`. Nothing deleted them, so heavy
 * use filled the temporary folder. This module is the single place that
 * decides what is safe to delete: only files with known launcher suffixes and
 * only when their mtime is older than the retention. Fresh files stay so
 * running children and recent resumes keep working.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Default retention for scratch files: a week keeps recent resumes working. */
export const DEFAULT_PRUNE_MAX_AGE_DAYS = 7;

export interface PruneOptions {
  /** Maximum file age in milliseconds; older managed files are deleted. */
  maxAgeMs: number;
  /** List without deleting when true. */
  dryRun?: boolean;
  /** Clock override for tests; defaults to `Date.now()`. */
  now?: number;
}

export interface PruneResult {
  scanned: number;
  deleted: string[];
  deletedBytes: number;
}

/** Suffixes the launcher owns inside the scratch directory. */
function isManagedScratchFile(name: string): boolean {
  return (
    name.endsWith(".json") ||
    name.endsWith(".jsonl") ||
    name.endsWith(".prompt.md") ||
    name.endsWith(".role.md") ||
    name.endsWith(".resume.md") ||
    name.endsWith(".exit") ||
    name.endsWith(".msg") ||
    name.endsWith(".report.md")
  );
}

function pruneDir(
  dir: string,
  matches: (name: string) => boolean,
  options: PruneOptions,
): PruneResult {
  const result: PruneResult = { scanned: 0, deleted: [], deletedBytes: 0 };
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!matches(name)) continue;
    const path = join(dir, name);
    let mtime: number;
    let size: number;
    let isFile: boolean;
    try {
      const stat = statSync(path);
      isFile = stat.isFile();
      mtime = stat.mtimeMs;
      size = stat.size;
    } catch {
      continue;
    }
    if (!isFile) continue;
    result.scanned += 1;
    if (mtime > now - options.maxAgeMs) continue;
    if (!options.dryRun) {
      try {
        rmSync(path, { force: true });
      } catch {
        continue;
      }
    }
    result.deleted.push(path);
    result.deletedBytes += size;
  }
  result.deleted.sort((a, b) => a.localeCompare(b));
  return result;
}

/** Delete old launcher files inside a scratch directory. */
export function pruneScratch(dir: string, options: PruneOptions): PruneResult {
  return pruneDir(dir, isManagedScratchFile, options);
}

/** Default scratch directory: `<tmp>/foreman`. */
export function defaultScratchDir(): string {
  return join(tmpdir(), "foreman");
}

/**
 * Best-effort cleanup after a start. It never throws: a full or read-only
 * tmp folder must not fail the launch it was meant to protect.
 */
export function autoPrune(
  scratchDir: string,
  maxAgeDays = DEFAULT_PRUNE_MAX_AGE_DAYS,
): void {
  try {
    pruneScratch(scratchDir, { maxAgeMs: maxAgeDays * 86_400_000 });
  } catch {
    // Best effort; the launch continues.
  }
}
