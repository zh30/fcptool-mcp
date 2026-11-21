import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { runFcptool, locateFcptool, binaryStamp, procSlots, stats as procStats } from './fcptool.ts';
import { KeyedLock } from './concurrency.ts';
import { LibraryCache, memoByStamp } from './cache.ts';
import { resolveUserPath, libraryKey } from './paths.ts';
import { ToolError } from './errors.ts';
import { fastValidate, inspectFcpxml, availableDtds, type InspectDetail, type ValidationResult } from './fcpxml.ts';
import { lockHolders, finalCutProcess, openLibraries, findLibraries } from './fcpstate.ts';

export interface Ctx {
  signal?: AbortSignal;
  progress?: (message: string) => void;
}

const locks = new KeyedLock();
const cache = new LibraryCache();

/** Runs fn while holding the locks of the given libraries; turns lock errors into actionable ones. */
async function withLibraries<T>(libs: string[], fn: () => Promise<T>, opts: { write: boolean }): Promise<T> {
  const keys = libs.map(libraryKey);
  const release = await locks.acquire(keys);
  try {
    // An external holder (another fcptool) usually lets go within a second; Final Cut Pro does not.
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await fn();
        if (opts.write) for (const k of keys) cache.invalidate(k);
        return out;
      } catch (e) {
        if (!(e instanceof ToolError) || e.code !== 'LIBRARY_LOCKED') throw e;
        const holders = await lockHolders(libs.filter((l) => existsSync(l)));
        const byFcp = [...holders.entries()].filter(([, hs]) => hs.some((h) => h.command.startsWith('Final Cut')));
        if (byFcp.length || attempt >= 2) {
          e.details = { ...e.details, heldBy: Object.fromEntries([...holders.entries()].filter(([, h]) => h.length)) };
          if (byFcp.length) e.hint = `Open in Final Cut Pro: ${byFcp.map(([l]) => path.basename(l)).join(', ')}. Close it there (File > Close Library) and retry; this server will not close it for you.`;
          throw e;
        }
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
  } finally {
    release();
  }
}

const cacheKey = (kind: string, lib: string) => `${kind}|${libraryKey(lib)}`;
const upgradeFlag = (autoUpgrade?: boolean) => (autoUpgrade ? ['--update'] : []);

// ---------------------------------------------------------------- static data

const staticInfo = memoByStamp(async () => {
  const [version, xmlVersions, views] = await Promise.all([
    runFcptool(['--version']),
    runFcptool(['xml', 'versions']),
    runFcptool(['metadata-view', 'list']),
  ]);
  return { version: version.data, fcpxml: xmlVersions.data, metadataViews: views.data.viewSets ?? views.data };
});

export async function getStatic() {
  const { bin } = await locateFcptool();
  return staticInfo(binaryStamp(bin));
}

/** Warm the static cache in the background so the first status call is instant. */
export function prewarm() {
  getStatic().catch(() => undefined);
}

export async function status(opts: { includeOpenLibraries?: boolean } = {}) {
  const { bin, app } = await locateFcptool();
  const [st, fcp, dtds] = await Promise.all([getStatic(), finalCutProcess(), availableDtds(app)]);
  const open = fcp.running && opts.includeOpenLibraries !== false && fcp.pid ? await openLibraries(fcp.pid) : [];
  return {
    fcptool: { path: bin, ...st.version },
    fcpxml: { exportVersions: st.fcpxml.versions, defaultExportVersion: st.fcpxml.default, validatableVersions: dtds },
    metadataViews: st.metadataViews,
    finalCutPro: { running: fcp.running, pid: fcp.pid, openLibraries: open },
    server: { processes: procSlots.stats, fcptoolCalls: procStats.calls, avgCallMs: procStats.calls ? Math.round(procStats.totalMs / procStats.calls) : undefined, cache: { entries: cache.size, hits: cache.hits, misses: cache.misses } },
  };
}

// ---------------------------------------------------------------- libraries

export type LibraryPart = 'info' | 'settings' | 'events';

export async function libraryInspect(p: string, include: LibraryPart[] = ['info', 'settings', 'events'], opts: { fresh?: boolean; autoUpgrade?: boolean } = {}, ctx: Ctx = {}) {
  const lib = resolveUserPath(p, 'library');
  if (!existsSync(lib)) throw new ToolError('NOT_FOUND', `no library at ${lib}`);
  const out: Record<string, unknown> = { path: lib };
  const cachedParts: string[] = [];
  const read = async (part: LibraryPart, args: string[], pick: (d: any) => unknown) => {
    const r = await cache.get(cacheKey(part, lib), lib, async () => pick((await runFcptool(args, { signal: ctx.signal, killable: true })).data), opts.fresh);
    if (r.cached) cachedParts.push(part);
    out[part] = r.value;
  };
  // info does not open the catalog (works even while FCP has the library open), so it runs outside the lock.
  const tasks: Promise<void>[] = [];
  if (include.includes('info')) tasks.push(read('info', ['library', 'info', lib], (d) => d));
  const locked = include.filter((x) => x !== 'info');
  if (locked.length)
    tasks.push(
      withLibraries([lib], async () => {
        if (locked.includes('settings')) await read('settings', ['library', 'settings', lib, ...upgradeFlag(opts.autoUpgrade)], (d) => d);
        if (locked.includes('events')) await read('events', ['event', 'list', lib, ...upgradeFlag(opts.autoUpgrade)], (d) => d.events ?? d);
      }, { write: false }),
    );
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed && Object.keys(out).length === 1) throw failed.reason;
  if (failed) out.partialError = failed.reason instanceof ToolError ? failed.reason.toJSON() : String(failed.reason);
  if (cachedParts.length) out.cached = cachedParts;
  return out;
}

export interface SettingsChange {
  colorProcessingMode?: 'standard-gamut-sdr' | 'wide-gamut-hdr' | 'legacy-wide-gamut';
  mediaLocation?: string;
  cacheLocation?: string;
  motionContentLocation?: 'project' | 'templates';
  backupPolicy?: string;
}

function settingsArgs(s: SettingsChange): string[] {
  const args: string[] = [];
  const loc = (v: string, keywords: string[], what: string) => (keywords.includes(v) ? v : resolveUserPath(v, what));
  if (s.colorProcessingMode) args.push('--color-processing-mode', s.colorProcessingMode);
  if (s.mediaLocation) args.push('--media-location', loc(s.mediaLocation, ['project'], 'mediaLocation'));
  if (s.cacheLocation) args.push('--cache-location', loc(s.cacheLocation, ['project'], 'cacheLocation'));
  if (s.motionContentLocation) args.push('--motion-content-location', s.motionContentLocation);
  if (s.backupPolicy) args.push('--backup-policy', loc(s.backupPolicy, ['none', 'default'], 'backupPolicy'));
  return args;
}

export async function librarySettings(p: string, change: SettingsChange = {}, opts: { autoUpgrade?: boolean } = {}, ctx: Ctx = {}) {
  const lib = resolveUserPath(p, 'library');
  const args = settingsArgs(change);
  const isWrite = args.length > 0;
  return withLibraries([lib], async () => {
    if (!isWrite) return (await cache.get(cacheKey('settings', lib), lib, async () => (await runFcptool(['library', 'settings', lib, ...upgradeFlag(opts.autoUpgrade)], { signal: ctx.signal })).data)).value;
    const r = await runFcptool(['library', 'settings', lib, ...args, ...upgradeFlag(opts.autoUpgrade)], { signal: ctx.signal, killable: false });
    return { path: lib, ...r.data };
  }, { write: isWrite });
}

export async function libraryCreate(p: string, opts: { events?: string[]; settings?: SettingsChange } = {}, ctx: Ctx = {}) {
  const lib = resolveUserPath(p, 'library');
  if (!lib.endsWith('.fcpbundle')) throw new ToolError('INVALID_ARGUMENT', `library path must end with .fcpbundle: ${lib}`);
  if (existsSync(lib)) throw new ToolError('ALREADY_EXISTS', `${lib} already exists`);
  const settingArgs = opts.settings ? settingsArgs(opts.settings) : [];
  return withLibraries([lib], async () => {
    const steps: unknown[] = [];
    await runFcptool(['library', 'new', lib], { signal: ctx.signal, killable: false });
    ctx.progress?.('library created');
    for (const name of opts.events ?? []) {
      steps.push((await runFcptool(['event', 'new', lib, '--name', name], { killable: false })).data);
      ctx.progress?.(`event "${name}" created`);
    }
    let settings: unknown;
    if (settingArgs.length) settings = (await runFcptool(['library', 'settings', lib, ...settingArgs], { killable: false })).data;
    return { path: lib, eventsCreated: steps.map((s: any) => s?.name), ...(settings ? { settings } : {}), note: 'Final Cut Pro also adds a default event named after today\'s date.' };
  }, { write: true });
}

export async function libraryUpgrade(p: string, ctx: Ctx = {}) {
  const lib = resolveUserPath(p, 'library');
  return withLibraries([lib], async () => ({ path: lib, ...(await runFcptool(['library', 'update', lib], { signal: ctx.signal, killable: false })).data }), { write: true });
}

// ---------------------------------------------------------------- events

export async function eventList(p: string, opts: { fresh?: boolean; autoUpgrade?: boolean } = {}, ctx: Ctx = {}) {
  const r = await libraryInspect(p, ['events'], opts, ctx);
  return { path: r.path, events: r.events, ...(r.cached ? { cached: true } : {}) };
}

export async function eventCreate(p: string, names: string[], opts: { autoUpgrade?: boolean } = {}, ctx: Ctx = {}) {
  const lib = resolveUserPath(p, 'library');
  if (!names.length) throw new ToolError('INVALID_ARGUMENT', 'names must contain at least one event name');
  return withLibraries([lib], async () => {
    const created: string[] = [];
    for (const name of names) {
      const r = await runFcptool(['event', 'new', lib, '--name', name, ...upgradeFlag(opts.autoUpgrade)], { killable: false });
      created.push(r.data?.name ?? name);
      ctx.progress?.(`event "${name}" created`);
    }
    return { path: lib, created };
  }, { write: true });
}

export interface CopyMedia {
  withoutMedia?: boolean;
  includeOriginalMedia?: boolean;
  includeOptimizedMedia?: boolean;
  includeProxyMedia?: boolean;
  copyExternalMedia?: boolean;
}

export async function eventCopy(from: string, to: string, names: string[], media: CopyMedia = {}, opts: { autoUpgrade?: boolean } = {}, ctx: Ctx = {}) {
  const src = resolveUserPath(from, 'from');
  const dst = resolveUserPath(to, 'to');
  if (!names.length) throw new ToolError('INVALID_ARGUMENT', 'names must contain at least one event name');
  const flags: string[] = [];
  const b = (flag: string, v?: boolean) => v !== undefined && flags.push(flag, String(v));
  b('--without-media', media.withoutMedia);
  b('--include-original-media', media.includeOriginalMedia);
  b('--include-optimized-media', media.includeOptimizedMedia);
  b('--include-proxy-media', media.includeProxyMedia);
  b('--copy-external-media', media.copyExternalMedia);
  return withLibraries([src, dst], async () => {
    const copied: string[] = [];
    for (const name of names) {
      await runFcptool(['event', 'copy', '--name', name, '--from', src, '--to', dst, ...flags, ...upgradeFlag(opts.autoUpgrade)], { killable: false, verbose: !!ctx.progress, onStderrLine: ctx.progress });
      copied.push(name);
    }
    return { from: src, to: dst, copied };
  }, { write: true });
}

// ---------------------------------------------------------------- FCPXML

/** Accept either a path or inline XML (written to a private temp file). */
async function materialize(input: { path?: string; xml?: string }): Promise<{ file: string; cleanup: () => Promise<void> }> {
  if (input.path && input.xml) throw new ToolError('INVALID_ARGUMENT', 'pass either path or xml, not both');
  if (input.path) return { file: resolveUserPath(input.path, 'path'), cleanup: async () => {} };
  if (!input.xml) throw new ToolError('INVALID_ARGUMENT', 'path or xml is required');
  const dir = await mkdtemp(path.join(tmpdir(), 'fcptool-mcp-'));
  const file = path.join(dir, 'inline.fcpxml');
  await writeFile(file, input.xml, 'utf8');
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function xmlValidate(input: { path?: string; xml?: string; engine?: 'auto' | 'fast' | 'fcptool' }, ctx: Ctx = {}): Promise<ValidationResult & { file?: string }> {
  const { file, cleanup } = await materialize(input);
  try {
    const engine = input.engine ?? 'auto';
    if (engine !== 'fcptool') {
      const { app } = await locateFcptool();
      const fast = await fastValidate(app, file);
      if (fast) return { ...fast, ...(input.path ? { file } : {}) };
      if (engine === 'fast') throw new ToolError('FCPTOOL_ERROR', 'fast validation unavailable (xmllint or bundled DTD missing); use engine "fcptool"');
    }
    const started = Date.now();
    const r = await runFcptool(['xml', 'validate', file], { signal: ctx.signal, killable: true });
    return { valid: !!r.data.valid, version: r.data.version, errors: (r.data.errors ?? []).map((m: string) => ({ message: m.trim() })), engine: 'fcptool', ms: Date.now() - started, ...(input.path ? { file } : {}) };
  } finally {
    await cleanup();
  }
}

export async function xmlInspect(input: { path?: string; xml?: string; detail?: InspectDetail; maxItems?: number }) {
  const { file, cleanup } = await materialize(input);
  try {
    const r = await inspectFcpxml(file, input.detail, input.maxItems);
    if (!input.path) delete r.file;
    return r;
  } finally {
    await cleanup();
  }
}

export async function xmlImport(
  input: { path?: string; xml?: string; into?: string; newLibrary?: string; conflictResolution?: 'cancel' | 'keep-both' | 'replace'; validateFirst?: boolean; autoUpgrade?: boolean },
  ctx: Ctx = {},
) {
  if (!!input.into === !!input.newLibrary) throw new ToolError('INVALID_ARGUMENT', 'pass exactly one of into (existing library) or newLibrary (path for a new .fcpbundle)');
  const target = resolveUserPath((input.into ?? input.newLibrary)!, input.into ? 'into' : 'newLibrary');
  if (input.newLibrary && existsSync(target)) throw new ToolError('ALREADY_EXISTS', `${target} already exists; use into to import into it`);
  if (input.into && !existsSync(target)) throw new ToolError('NOT_FOUND', `no library at ${target}; use newLibrary to create one`);
  const { file, cleanup } = await materialize(input);
  try {
    if (input.validateFirst !== false) {
      const v = await xmlValidate({ path: file, engine: 'auto' });
      if (!v.valid) throw new ToolError('VALIDATION_FAILED', `FCPXML does not validate against DTD ${v.version ?? '?'}; nothing was imported`, 'Fix the listed errors (line numbers refer to the document) or pass validateFirst: false to let Final Cut Pro try anyway.', { errors: v.errors.slice(0, 50) });
    }
    const args = ['xml', 'import', file, input.into ? '--into' : '--new', target, '--conflict-resolution', input.conflictResolution ?? 'cancel', ...upgradeFlag(input.autoUpgrade)];
    return await withLibraries([target], async () => {
      const r = await runFcptool(args, { killable: false, verbose: !!ctx.progress, onStderrLine: ctx.progress });
      return { library: target, created: !!input.newLibrary, conflictResolution: input.conflictResolution ?? 'cancel', ...r.data };
    }, { write: true });
  } finally {
    await cleanup();
  }
}

export async function xmlExport(
  input: { library: string; output?: string; dtdVersion?: string; metadataView?: string; autoUpgrade?: boolean; inspect?: InspectDetail | 'none'; maxItems?: number },
  ctx: Ctx = {},
) {
  const lib = resolveUserPath(input.library, 'library');
  let output: string;
  if (input.output) {
    output = resolveUserPath(input.output, 'output');
    if (!/\.fcpxmld?$/.test(output)) throw new ToolError('INVALID_ARGUMENT', 'output must end with .fcpxml or .fcpxmld');
  } else {
    const dir = path.join(tmpdir(), 'fcptool-mcp-exports');
    output = path.join(dir, `${path.basename(lib, '.fcpbundle')}-${Date.now()}.fcpxml`);
    await mkdir(dir, { recursive: true });
  }
  if (existsSync(output)) throw new ToolError('ALREADY_EXISTS', `${output} already exists`, 'Pick a new output path; this server never overwrites exports.');
  const args = ['xml', 'export', lib, '--output', output];
  if (input.dtdVersion) args.push('--dtd-version', input.dtdVersion);
  if (input.metadataView) args.push('--metadata-view', input.metadataView);
  args.push(...upgradeFlag(input.autoUpgrade));
  await withLibraries([lib], () => runFcptool(args, { signal: ctx.signal, killable: true }), { write: false });
  const out: any = { library: lib, output };
  const detail = input.inspect ?? 'summary';
  if (detail !== 'none') out.contents = await inspectFcpxml(output, detail, input.maxItems ?? 200);
  return out;
}

// ---------------------------------------------------------------- discovery

export async function libraryFind(input: { scopes?: string[]; includeBackups?: boolean; checkOpen?: boolean }) {
  const scopes = (input.scopes?.length ? input.scopes : [path.join(homedir(), 'Movies'), homedir()]).map((s) => resolveUserPath(s, 'scope'));
  const libs = await findLibraries([...new Set(scopes)], !!input.includeBackups);
  if (input.checkOpen !== false && libs.length) {
    const holders = await lockHolders(libs.map((l) => l.path));
    for (const l of libs as any[]) {
      const h = holders.get(l.path) ?? [];
      l.openIn = h.map((x) => x.command);
    }
  }
  return { count: libs.length, libraries: libs };
}

// ---------------------------------------------------------------- batch

export const batchable = {
  library_inspect: (a: any, c: Ctx) => libraryInspect(a.path, a.include, a, c),
  library_create: (a: any, c: Ctx) => libraryCreate(a.path, a, c),
  library_settings: (a: any, c: Ctx) => librarySettings(a.path, a.set ?? {}, a, c),
  library_upgrade: (a: any, c: Ctx) => libraryUpgrade(a.path, c),
  event_list: (a: any, c: Ctx) => eventList(a.path, a, c),
  event_create: (a: any, c: Ctx) => eventCreate(a.path, a.names, a, c),
  event_copy: (a: any, c: Ctx) => eventCopy(a.from, a.to, a.names, a, a, c),
  xml_validate: (a: any, c: Ctx) => xmlValidate(a, c),
  xml_inspect: (a: any) => xmlInspect(a),
  xml_import: (a: any, c: Ctx) => xmlImport(a, c),
  xml_export: (a: any, c: Ctx) => xmlExport(a, c),
} as const;

export type BatchOp = { op: keyof typeof batchable; args: Record<string, unknown>; id?: string };

const PATH_ARGS = ['path', 'library', 'from', 'to', 'into', 'newLibrary', 'output'];

function opKeys(o: BatchOp): string[] {
  const keys: string[] = [];
  for (const k of PATH_ARGS) {
    const v = o.args?.[k];
    if (typeof v === 'string') {
      try {
        keys.push(libraryKey(resolveUserPath(v)));
      } catch {
        /* invalid path: the op itself will report it */
      }
    }
  }
  return keys;
}

/**
 * Runs a list of operations as a dependency graph: an op waits for every earlier op that
 * touches one of the same paths (so "create library, then import into it" is safe), and
 * ops on unrelated libraries run in parallel. With stopOnError, ops that have not started
 * when something fails are skipped.
 */
export async function batch(ops: BatchOp[], opts: { stopOnError?: boolean } = {}, ctx: Ctx = {}) {
  const started = Date.now();
  let failed = false;
  const done: Promise<unknown>[] = [];
  const keysOf = ops.map(opKeys);
  const results = await Promise.all(
    ops.map((o, i) => {
      const deps = done.filter((_, j) => keysOf[j].some((k) => keysOf[i].includes(k)));
      const p = (async () => {
        const id = o.id ?? String(i);
        await Promise.all(deps);
        if (failed && opts.stopOnError) return { id, op: o.op, ok: false, skipped: true };
        const fn = batchable[o.op];
        if (!fn) {
          failed = true;
          return { id, op: o.op, ok: false, error: { code: 'INVALID_ARGUMENT', message: `unknown op ${o.op}; valid: ${Object.keys(batchable).join(', ')}` } };
        }
        const t = Date.now();
        try {
          const result = await fn(o.args ?? {}, ctx);
          return { id, op: o.op, ok: true, ms: Date.now() - t, result };
        } catch (e) {
          failed = true;
          return { id, op: o.op, ok: false, ms: Date.now() - t, error: e instanceof ToolError ? e.toJSON() : { code: 'FCPTOOL_ERROR', message: String((e as Error)?.message ?? e) } };
        }
      })();
      done.push(p);
      return p;
    }),
  );
  return { ms: Date.now() - started, ok: results.every((r) => r.ok), results };
}
