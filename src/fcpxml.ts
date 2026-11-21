import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { ToolError } from './errors.ts';

const execFileP = promisify(execFile);

/** A .fcpxmld bundle keeps its document in Info.fcpxml. */
export function documentFile(p: string): string {
  if (!existsSync(p)) throw new ToolError('NOT_FOUND', `no such file: ${p}`);
  if (statSync(p).isDirectory()) {
    const inner = path.join(p, 'Info.fcpxml');
    if (!existsSync(inner)) throw new ToolError('INVALID_ARGUMENT', `${p} is a directory without Info.fcpxml (not an .fcpxmld bundle)`);
    return inner;
  }
  return p;
}

export async function sniffVersion(file: string): Promise<string | undefined> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return /<fcpxml[^>]*\sversion="([0-9.]+)"/.exec(buf.subarray(0, bytesRead).toString('utf8'))?.[1];
  } finally {
    await fh.close();
  }
}

export function dtdPath(app: string, version: string): string {
  return `${app}/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv${version.replace(/\./g, '_')}.dtd`;
}

export async function availableDtds(app: string): Promise<string[]> {
  const dir = `${app}/Contents/Frameworks/Interchange.framework/Versions/A/Resources`;
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .map((n) => /^FCPXMLv(\d+)_(\d+)\.dtd$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${m[1]}.${m[2]}`)
    .sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]));
}

export interface ValidationIssue {
  line?: number;
  element?: string;
  message: string;
}
export interface ValidationResult {
  valid: boolean;
  version?: string;
  errors: ValidationIssue[];
  engine: 'xmllint' | 'fcptool';
  ms: number;
}

/**
 * Validates against the exact DTD bundled in Final Cut Pro with libxml2's xmllint
 * (~50 ms, adds line numbers) — the same check fcptool performs, without its ~2 s start-up.
 * Returns undefined when the fast path is unavailable so the caller can fall back to fcptool.
 */
export async function fastValidate(app: string, docPath: string): Promise<ValidationResult | undefined> {
  const started = Date.now();
  const file = documentFile(docPath);
  const version = await sniffVersion(file);
  if (!version) return { valid: false, errors: [{ message: 'no <fcpxml version="…"> root element found' }], engine: 'xmllint', ms: Date.now() - started };
  const dtd = dtdPath(app, version);
  if (!existsSync(dtd)) return { valid: false, version, errors: [{ message: `FCPXML version ${version} is not supported by this Final Cut Pro (no DTD bundled)` }], engine: 'xmllint', ms: Date.now() - started };
  const dtdUrl = 'file://' + dtd.split('/').map(encodeURIComponent).join('/');
  let out = '';
  let code = 0;
  try {
    await execFileP('xmllint', ['--noout', '--nonet', '--dtdvalid', dtdUrl, file], { timeout: 120_000, maxBuffer: 64 << 20 });
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined;
    code = typeof e?.code === 'number' ? e.code : 1;
    out = `${e?.stderr ?? ''}`;
  }
  if (code === 0) return { valid: true, version, errors: [], engine: 'xmllint', ms: Date.now() - started };
  const errors: ValidationIssue[] = [];
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^.*?:(\d+): (?:element ([^:]+): )?(?:validity|parser|namespace) (?:error|warning) : (.*)$/.exec(lines[i]);
    if (m) errors.push({ line: Number(m[1]), ...(m[2] ? { element: m[2] } : {}), message: m[3].trim() });
  }
  if (/Could not parse DTD|failed to load/i.test(out) && !errors.length) return undefined;
  if (!errors.length) errors.push({ message: out.trim().split('\n').filter((l) => !/does not validate against/.test(l)).join(' ') || `xmllint exit ${code}` });
  return { valid: false, version, errors, engine: 'xmllint', ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Inspection: read an FCPXML document into an agent-sized summary.
// ---------------------------------------------------------------------------

interface Node {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
}

function toTree(raw: any[]): Node[] {
  const out: Node[] = [];
  for (const item of raw) {
    const attrs = (item[':@'] ?? {}) as Record<string, string>;
    const name = Object.keys(item).find((k) => k !== ':@');
    if (name === '#text') {
      out.push({ name, attrs: { value: String(item[name]) }, children: [] });
      continue;
    }
    if (!name || name.startsWith('#') || name.startsWith('?')) continue;
    out.push({ name, attrs, children: Array.isArray(item[name]) ? toTree(item[name]) : [] });
  }
  return out;
}

/** "1001/30000s" | "10s" | "0s" -> seconds */
export function fcpTime(t?: string): number | undefined {
  if (!t) return undefined;
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(t.trim());
  if (!m) return undefined;
  return Number(m[1]) / (m[2] ? Number(m[2]) : 1);
}

const round = (n?: number) => (n === undefined ? undefined : Math.round(n * 1000) / 1000);

export function formatTimecode(sec: number | undefined, fps: number | undefined): string | undefined {
  if (sec === undefined) return undefined;
  const f = fps && fps > 0 ? Math.round(fps) : 0;
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = Math.floor(total % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return f ? `${base}:${pad(Math.floor((total - Math.floor(total)) * f + 1e-6))}` : base;
}

const CLIP_TAGS = new Set(['asset-clip', 'clip', 'ref-clip', 'sync-clip', 'mc-clip', 'video', 'audio', 'title', 'gap', 'transition', 'audition', 'live-drawing']);

export type InspectDetail = 'summary' | 'timeline' | 'full';

export async function inspectFcpxml(docPath: string, detail: InspectDetail = 'summary', maxItems = 200) {
  const file = documentFile(docPath);
  const xml = await readFile(file, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true, parseAttributeValue: false, trimValues: true, processEntities: true });
  let tree: Node[];
  try {
    tree = toTree(parser.parse(xml));
  } catch (e: any) {
    throw new ToolError('VALIDATION_FAILED', `not well-formed XML: ${e?.message ?? e}`);
  }
  const root = tree.find((n) => n.name === 'fcpxml');
  if (!root) throw new ToolError('INVALID_ARGUMENT', 'document has no <fcpxml> root element');

  let truncated = false;
  const cap = <T>(arr: T[]): T[] => {
    if (arr.length > maxItems) {
      truncated = true;
      return arr.slice(0, maxItems);
    }
    return arr;
  };

  const resources = root.children.find((n) => n.name === 'resources');
  const formats = new Map<string, { id: string; name?: string; fps?: number; width?: number; height?: number; colorSpace?: string }>();
  const assets: any[] = [];
  const media: any[] = [];
  const effects: any[] = [];
  for (const r of resources?.children ?? []) {
    const a = r.attrs;
    if (r.name === 'format') {
      const fd = fcpTime(a.frameDuration);
      formats.set(a.id, { id: a.id, name: a.name, fps: fd ? round(1 / fd) : undefined, width: a.width ? Number(a.width) : undefined, height: a.height ? Number(a.height) : undefined, colorSpace: a.colorSpace });
    } else if (r.name === 'asset') {
      const rep = r.children.find((c) => c.name === 'media-rep');
      assets.push({ id: a.id, name: a.name, duration: round(fcpTime(a.duration)), hasVideo: a.hasVideo === '1', hasAudio: a.hasAudio === '1', format: a.format, src: rep?.attrs.src ?? a.src });
    } else if (r.name === 'media') {
      media.push({ id: a.id, name: a.name, kind: r.children[0]?.name });
    } else if (r.name === 'effect') {
      effects.push({ id: a.id, name: a.name, uid: a.uid });
    }
  }

  const clipSummary = (n: Node, fps?: number): any => {
    const a = n.attrs;
    const item: any = { type: n.name, name: a.name ?? a.ref };
    if (a.offset) item.offset = round(fcpTime(a.offset));
    if (a.start) item.start = round(fcpTime(a.start));
    if (a.duration) item.duration = round(fcpTime(a.duration));
    if (a.lane) item.lane = Number(a.lane);
    if (a.ref) item.ref = a.ref;
    if (a.enabled === '0') item.enabled = false;
    const markers = n.children.filter((c) => c.name === 'marker' || c.name === 'chapter-marker').map((m) => ({ type: m.name, value: m.attrs.value, start: round(fcpTime(m.attrs.start)) }));
    if (markers.length) item.markers = markers;
    const keywords = n.children.filter((c) => c.name === 'keyword').map((k) => k.attrs.value);
    if (keywords.length) item.keywords = keywords;
    const filters = n.children.filter((c) => c.name.startsWith('filter-')).map((f) => f.attrs.name ?? f.attrs.ref);
    if (filters.length) item.effects = filters;
    if (n.name === 'title') {
      const text = collectText(n);
      if (text) item.text = text.slice(0, 200);
    }
    const connected = n.children.filter((c) => CLIP_TAGS.has(c.name));
    if (connected.length && detail !== 'summary') item.connected = connected.map((c) => clipSummary(c, fps));
    if (n.name === 'audition' && detail === 'full') item.alternatives = n.children.filter((c) => CLIP_TAGS.has(c.name)).length;
    void fps;
    return item;
  };

  const projectSummary = (p: Node) => {
    const seq = p.children.find((c) => c.name === 'sequence');
    const fmt = seq ? formats.get(seq.attrs.format) : undefined;
    const spine = seq?.children.find((c) => c.name === 'spine');
    const items = (spine?.children ?? []).filter((c) => CLIP_TAGS.has(c.name));
    const byType: Record<string, number> = {};
    let markerCount = 0;
    const countAll = (n: Node) => {
      for (const c of n.children) {
        if (CLIP_TAGS.has(c.name)) byType[c.name] = (byType[c.name] ?? 0) + 1;
        if (c.name === 'marker' || c.name === 'chapter-marker') markerCount++;
        countAll(c);
      }
    };
    if (spine) countAll(spine);
    const duration = fcpTime(seq?.attrs.duration);
    const out: any = {
      name: p.attrs.name,
      uid: p.attrs.uid,
      modified: p.attrs.modDate,
      format: fmt ? { name: fmt.name, width: fmt.width, height: fmt.height, fps: fmt.fps } : seq?.attrs.format,
      duration: round(duration),
      durationTimecode: formatTimecode(duration, fmt?.fps),
      tcStart: round(fcpTime(seq?.attrs.tcStart)),
      audioLayout: seq?.attrs.audioLayout,
      audioRate: seq?.attrs.audioRate,
      primaryStoryline: items.length,
      itemsByType: byType,
      markers: markerCount,
    };
    if (detail !== 'summary') out.spine = cap(items.map((c) => clipSummary(c, fmt?.fps)));
    return out;
  };

  const eventSummary = (e: Node) => {
    const projects = e.children.filter((c) => c.name === 'project');
    const clips = e.children.filter((c) => CLIP_TAGS.has(c.name));
    const collections = e.children.filter((c) => c.name === 'keyword-collection' || c.name === 'collection-folder' || c.name === 'smart-collection');
    const out: any = {
      name: e.attrs.name,
      uid: e.attrs.uid,
      clipCount: clips.length,
      projectCount: projects.length,
      projects: cap(projects.map(projectSummary)),
    };
    if (collections.length) out.collections = cap(collections.map((c) => ({ type: c.name, name: c.attrs.name })));
    if (detail !== 'summary') out.clips = cap(clips.map((c) => clipSummary(c)));
    else if (clips.length) out.clipNames = cap(clips.map((c) => c.attrs.name ?? c.attrs.ref));
    return out;
  };

  const libraries = root.children.filter((n) => n.name === 'library');
  const looseEvents = root.children.filter((n) => n.name === 'event');
  const looseProjects = root.children.filter((n) => n.name === 'project');
  const looseClips = root.children.filter((n) => CLIP_TAGS.has(n.name));

  const result: any = {
    file,
    version: root.attrs.version,
    resources: {
      formats: cap([...formats.values()]),
      assetCount: assets.length,
      mediaCount: media.length,
      effectCount: effects.length,
      ...(detail === 'summary' ? { assets: cap(assets.map((a) => ({ id: a.id, name: a.name, duration: a.duration }))) } : { assets: cap(assets), media: cap(media), effects: cap(effects) }),
    },
    libraries: libraries.map((l) => ({ location: l.attrs.location, events: cap(l.children.filter((c) => c.name === 'event').map(eventSummary)) })),
  };
  if (looseEvents.length) result.events = cap(looseEvents.map(eventSummary));
  if (looseProjects.length) result.projects = cap(looseProjects.map(projectSummary));
  if (looseClips.length) result.clips = cap(looseClips.map((c) => clipSummary(c)));
  if (truncated) result.truncated = `lists capped at maxItems=${maxItems}`;
  return result;
}

function collectText(n: Node): string {
  let s = '';
  for (const c of n.children) {
    if (c.name === '#text') s += c.attrs.value;
    else if (c.name === 'text-style' || c.name === 'text') s += collectText(c);
  }
  return s.trim();
}
