import { homedir } from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { ToolError } from './errors.ts';

/** Expands ~ and requires an absolute result: the server's cwd is not the agent's cwd. */
export function resolveUserPath(p: string, what = 'path'): string {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('INVALID_ARGUMENT', `${what} is required`);
  let s = p.trim();
  if (s.startsWith('file://')) s = decodeURIComponent(new URL(s).pathname);
  if (s === '~' || s.startsWith('~/')) s = path.join(homedir(), s.slice(1));
  if (!path.isAbsolute(s))
    throw new ToolError('INVALID_ARGUMENT', `${what} must be absolute (or start with ~/): ${p}`, 'The MCP server does not share the agent\'s working directory; pass an absolute path.');
  return path.normalize(s).replace(/\/+$/, '') || '/';
}

/** Stable lock/cache key: realpath when it exists (follows symlinks), case-folded (APFS default). */
export function libraryKey(absPath: string): string {
  let p = absPath;
  try {
    p = realpathSync(absPath);
  } catch {
    try {
      p = path.join(realpathSync(path.dirname(absPath)), path.basename(absPath));
    } catch {
      /* parent missing too: keep as-is */
    }
  }
  return p.toLowerCase();
}
