/**
 * Skill shim: find the foreman checkout and hand the argv to its CLI.
 * `npx skills add` copies this file into the skill directory, so it stays
 * self-contained (Node builtins only) and loads the CLI from the package root
 * it finds at run time.
 *
 * Lookup order: `PI_FOREMAN_DIR`, then the checkout holding this file's
 * resolved real path (this file lives at <root>/skills/foreman/launch.ts).
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Paths that mark a package root, relative to it. */
const CLI_RELATIVE = join("src", "cli.ts");
const DONE_RELATIVE = join("extension", "foreman-done", "index.ts");

/** Injected process pieces, forwarded to the CLI; the defaults are the real process. */
export interface ShimDeps {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Package roots to try for a shim at `shimPath`, in lookup order. */
export function packageRootCandidates(
  shimPath: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const candidates: string[] = [];
  if (env.PI_FOREMAN_DIR) candidates.push(env.PI_FOREMAN_DIR);
  // This file lives at <root>/skills/foreman/launch.ts.
  candidates.push(resolve(dirname(resolved(shimPath)), "..", ".."));
  return candidates;
}

/** First candidate holding both entry points; throws otherwise. */
export function findPackageRoot(
  shimPath: string,
  env: NodeJS.ProcessEnv,
): string {
  const candidates = packageRootCandidates(shimPath, env);
  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, CLI_RELATIVE)) &&
      existsSync(join(candidate, DONE_RELATIVE))
    ) {
      return candidate;
    }
  }
  throw new Error(
    `Cannot find the foreman package (no ${CLI_RELATIVE} and ${DONE_RELATIVE} in: ` +
      `${candidates.join(", ")}). Point PI_FOREMAN_DIR at the foreman checkout.`,
  );
}

/**
 * Run one CLI invocation from the skill dir: find the package root, load its
 * CLI, and run it. Throws when no root holds the package, before the CLI —
 * and therefore any tmux command — runs.
 */
export async function main(
  argv: string[],
  deps: ShimDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const root = findPackageRoot(fileURLToPath(import.meta.url), env);
  const cli = (await import(pathToFileURL(join(root, CLI_RELATIVE)).href)) as {
    main: (argv: string[], deps: ShimDeps) => Promise<number>;
  };
  return cli.main(argv, deps);
}

/** True when this file is the process entry, not an import from a test. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolved(entry) === resolved(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`launch.ts: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
