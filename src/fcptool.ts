import { spawn, execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { availableParallelism } from 'node:os';
import { ToolError, classifyFcptoolError } from './errors.ts';
import { Semaphore } from './concurrency.ts';

const execFileP = promisify(execFile);

const DEFAULT_APP = '/Applications/Final Cut Pro.app';
const REL_BIN = 'Contents/MacOS/fcptool';

let located: { bin: string; app: string } | undefined;

/** FCPTOOL_PATH > FCP_APP_PATH > /Applications > Spotlight lookup by bundle id. */
export async function locateFcptool(): Promise<{ bin: string; app: string }> {
  if (located && existsSync(located.bin)) return located;
  const candidates: string[] = [];
  if (process.env.FCPTOOL_PATH) candidates.push(process.env.FCPTOOL_PATH);
  if (process.env.FCP_APP_PATH) candidates.push(`${process.env.FCP_APP_PATH}/${REL_BIN}`);
  candidates.push(`${DEFAULT_APP}/${REL_BIN}`);
  for (const c of candidates) if (existsSync(c)) return (located = { bin: c, app: c.replace(/\/Contents\/MacOS\/fcptool$/, '') });
  try {
    const { stdout } = await execFileP('mdfind', ['kMDItemCFBundleIdentifier == "com.apple.FinalCut"'], { timeout: 5000 });
    for (const app of stdout.split('\n').filter(Boolean)) {
      const bin = `${app}/${REL_BIN}`;
      if (existsSync(bin)) return (located = { bin, app });
    }
  } catch {
    /* Spotlight unavailable */
  }
  throw new ToolError('FCPTOOL_NOT_FOUND', 'fcptool was not found. It ships inside Final Cut Pro 13+ at "Final Cut Pro.app/Contents/MacOS/fcptool".', 'Install or update Final Cut Pro 13, or set FCPTOOL_PATH to the fcptool binary.');
}

/** Identity of the installed binary, used to key caches of static data. */
export function binaryStamp(bin: string): string {
  const s = statSync(bin);
  return `${s.size}:${s.mtimeMs}`;
}

const maxProcs = Number(process.env.FCPTOOL_MCP_MAX_PROCS) || Math.max(2, Math.min(6, Math.floor(availableParallelism() / 2)));
export const procSlots = new Semaphore(maxProcs);

export interface RunOptions {
  /** Abort signal from the MCP request; only honoured when killable is true. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Read-only commands can be killed on cancel; writes run to completion so a library is never left half-written. */
  killable?: boolean;
  /** Receives each stderr line (status / progress when --verbose is passed). */
  onStderrLine?: (line: string) => void;
  verbose?: boolean;
}

export interface RunResult {
  data: any;
  stderr: string;
  ms: number;
  argv: string[];
}

export const stats = { calls: 0, totalMs: 0, failures: 0 };

/** Runs fcptool with --json and returns parsed stdout. Throws ToolError on failure. */
export async function runFcptool(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { bin } = await locateFcptool();
  const argv = [...args, '--json', ...(opts.verbose ? ['--verbose'] : [])];
  const release = await procSlots.acquire();
  const started = Date.now();
  try {
    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NSUnbufferedIO: 'YES' } });
      const out: Buffer[] = [];
      let err = '';
      let pending = '';
      let killedFor: 'TIMEOUT' | 'CANCELLED' | undefined;
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (s: string) => {
        err += s;
        if (opts.onStderrLine) {
          pending += s;
          const parts = pending.split('\n');
          pending = parts.pop() ?? '';
          for (const l of parts) if (l.trim()) opts.onStderrLine(l.trim());
        }
      });
      const kill = (why: 'TIMEOUT' | 'CANCELLED') => {
        killedFor = why;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      };
      const timeoutMs = opts.timeoutMs ?? (Number(process.env.FCPTOOL_MCP_TIMEOUT_MS) || 600_000);
      const timer = setTimeout(() => kill('TIMEOUT'), timeoutMs);
      const onAbort = () => opts.killable !== false && kill('CANCELLED');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new ToolError('FCPTOOL_ERROR', `failed to start fcptool: ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        const ms = Date.now() - started;
        stats.calls++;
        stats.totalMs += ms;
        const stdout = Buffer.concat(out).toString('utf8');
        if (killedFor) {
          stats.failures++;
          return reject(new ToolError(killedFor, killedFor === 'TIMEOUT' ? `fcptool timed out after ${timeoutMs} ms` : 'cancelled by client', undefined, { argv }));
        }
        if (code !== 0) {
          stats.failures++;
          // validate --json reports {valid:false, errors} with exit 1: hand that back as data.
          const parsed = tryParseJson(stdout);
          if (parsed && typeof parsed === 'object' && 'valid' in parsed) return resolve({ data: parsed, stderr: err, ms, argv });
          const c = classifyFcptoolError(`${err}\n${stdout}`);
          return reject(new ToolError(c.code, c.message, c.hint, { exitCode: code, argv: [bin.split('/').pop(), ...argv].join(' ') }));
        }
        const data = stdout.trim() ? tryParseJson(stdout) : {};
        if (data === undefined) return resolve({ data: { output: stdout.trim() }, stderr: err, ms, argv });
        resolve({ data, stderr: err, ms, argv });
      });
    });
  } finally {
    release();
  }
}

function tryParseJson(s: string): any {
  const i = s.indexOf('{');
  if (i < 0) return undefined;
  try {
    return JSON.parse(s.slice(i));
  } catch {
    return undefined;
  }
}
