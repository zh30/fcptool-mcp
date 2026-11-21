import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

export interface LockHolder {
  pid: number;
  command: string;
}

/**
 * Who holds each library's .lock, via one lsof call (~100 ms) instead of a 2 s fcptool
 * round-trip. Final Cut Pro keeps .lock open for every library it has open.
 */
export async function lockHolders(libraryPaths: string[]): Promise<Map<string, LockHolder[]>> {
  const result = new Map<string, LockHolder[]>();
  const locks = libraryPaths.map((p) => [p, path.join(p, '.lock')] as const).filter(([, l]) => existsSync(l));
  for (const p of libraryPaths) result.set(p, []);
  if (!locks.length) return result;
  let stdout = '';
  try {
    ({ stdout } = await execFileP('lsof', ['-F', 'pcn', ...locks.map(([, l]) => l)], { timeout: 10_000 }));
  } catch (e: any) {
    stdout = e?.stdout ?? ''; // lsof exits 1 when some files are not open
  }
  let cur: Partial<LockHolder> = {};
  const byLock = new Map(locks.map(([p, l]) => [l, p]));
  for (const line of stdout.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') cur = { pid: Number(val) };
    else if (tag === 'c') cur.command = val;
    else if (tag === 'n') {
      const lib = byLock.get(val);
      if (lib && cur.pid) {
        const list = result.get(lib)!;
        if (!list.some((h) => h.pid === cur.pid)) list.push({ pid: cur.pid, command: cur.command ?? '?' });
      }
    }
  }
  return result;
}

export async function finalCutProcess(): Promise<{ running: boolean; pid?: number }> {
  try {
    const { stdout } = await execFileP('pgrep', ['-x', 'Final Cut Pro'], { timeout: 5000 });
    const pid = Number(stdout.trim().split('\n')[0]);
    return pid ? { running: true, pid } : { running: false };
  } catch {
    return { running: false };
  }
}

/** Libraries Final Cut Pro currently has open (from the .lock files it holds). */
export async function openLibraries(pid: number): Promise<string[]> {
  try {
    const { stdout } = await execFileP('lsof', ['-p', String(pid), '-F', 'n'], { timeout: 10_000, maxBuffer: 64 << 20 });
    const libs = new Set<string>();
    for (const line of stdout.split('\n')) {
      const m = /^n(.+\.fcpbundle)\/\.lock$/.exec(line);
      if (m) libs.add(m[1]);
    }
    return [...libs];
  } catch {
    return [];
  }
}

export interface FoundLibrary {
  path: string;
  name: string;
  modified?: string;
  isBackup: boolean;
}

const isBackupPath = (p: string) => /\/Final Cut Backups(\.localized)?\//.test(p);

/** Spotlight first (instant); bounded directory walk for unindexed places such as /tmp or external drives. */
export async function findLibraries(scopes: string[], includeBackups: boolean, maxDepth = 5): Promise<FoundLibrary[]> {
  const found = new Set<string>();
  await Promise.all(
    scopes.map(async (scope) => {
      let hits: string[] = [];
      try {
        const { stdout } = await execFileP('mdfind', ['-onlyin', scope, "kMDItemFSName == '*.fcpbundle'"], { timeout: 10_000, maxBuffer: 16 << 20 });
        hits = stdout.split('\n').filter((l) => l.endsWith('.fcpbundle'));
      } catch {
        /* ignore */
      }
      if (!hits.length) hits = await walk(scope, maxDepth);
      for (const h of hits) found.add(h);
    }),
  );
  const libs = [...found]
    .filter((p) => !/\.fcpbundle\/.+\.fcpbundle$/.test(p)) // nested inside another bundle
    .filter((p) => includeBackups || !isBackupPath(p));
  const out = await Promise.all(
    libs.map(async (p) => {
      const s = await stat(p).catch(() => undefined);
      if (!s) return undefined;
      return { path: p, name: path.basename(p, '.fcpbundle'), modified: s.mtime.toISOString(), isBackup: isBackupPath(p) } as FoundLibrary;
    }),
  );
  return out.filter((x): x is FoundLibrary => !!x).sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
}

async function walk(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const hits: string[] = [];
  await Promise.all(
    entries.map(async (e) => {
      if (!e.isDirectory() || e.name.startsWith('.')) return;
      const full = path.join(dir, e.name);
      if (e.name.endsWith('.fcpbundle')) hits.push(full);
      else if (!e.name.endsWith('.app') && e.name !== 'node_modules' && e.name !== 'Library') hits.push(...(await walk(full, depth - 1)));
    }),
  );
  return hits;
}
