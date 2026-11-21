import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Cheap change-detector for a library bundle: stats of the catalog files and every
 * event's CurrentVersion.fcpevent (a few hundred µs). fcptool itself touches these
 * files when it opens a library, so the fingerprint is taken *after* our own call;
 * an unchanged fingerprint on the next call means nobody else wrote in between.
 */
export async function libraryFingerprint(lib: string): Promise<string | undefined> {
  try {
    const entries = await readdir(lib, { withFileTypes: true });
    const files = ['CurrentVersion.flexolibrary', 'Settings.plist', 'CurrentVersion.plist'];
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('__')) files.push(path.join(e.name, 'CurrentVersion.fcpevent'));
    const parts = await Promise.all(
      files.map(async (f) => {
        const s = await stat(path.join(lib, f)).catch(() => undefined);
        return s ? `${f}:${s.mtimeMs}:${s.size}` : `${f}:-`;
      }),
    );
    return parts.join('|');
  } catch {
    return undefined;
  }
}

interface Entry {
  fp: string;
  value: unknown;
  at: number;
}

export class LibraryCache {
  private map = new Map<string, Entry>();
  hits = 0;
  misses = 0;

  async get<T>(key: string, lib: string, compute: () => Promise<T>, fresh = false): Promise<{ value: T; cached: boolean }> {
    const e = this.map.get(key);
    if (!fresh && e) {
      const fp = await libraryFingerprint(lib);
      if (fp && fp === e.fp) {
        this.hits++;
        return { value: e.value as T, cached: true };
      }
    }
    this.misses++;
    const value = await compute();
    const fp = await libraryFingerprint(lib);
    if (fp) this.map.set(key, { fp, value, at: Date.now() });
    return { value, cached: false };
  }

  /** Drop everything known about a library after we (or a batch op) changed it. */
  invalidate(libKey: string) {
    for (const k of this.map.keys()) if (k.endsWith(`|${libKey}`)) this.map.delete(k);
  }

  get size() {
    return this.map.size;
  }
}

/** Memoize a promise for the lifetime of a stamp (e.g. the fcptool binary identity). */
export function memoByStamp<T>(fn: () => Promise<T>) {
  let stamp: string | undefined;
  let p: Promise<T> | undefined;
  return (currentStamp: string): Promise<T> => {
    if (!p || stamp !== currentStamp) {
      stamp = currentStamp;
      p = fn().catch((e) => {
        p = undefined;
        throw e;
      });
    }
    return p;
  };
}
