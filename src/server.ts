import { readFile } from 'node:fs/promises';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import * as ops from './ops.ts';
import { ToolError } from './errors.ts';
import { locateFcptool } from './fcptool.ts';
import { availableDtds, dtdPath } from './fcpxml.ts';

export const VERSION = '0.1.0';

const INSTRUCTIONS = `Final Cut Pro 13 control through Apple's official fcptool CLI (libraries, events, FCPXML import/export).
Performance: every fcptool process costs ~2.3 s to start, so prefer one call that does more:
- fcp_library_inspect returns info + settings + events at once; repeat reads are served from a change-detecting cache.
- fcp_xml_export returns a parsed summary of what it exported (pass inspect:"timeline" for clip-level detail), so you rarely need a separate read.
- fcp_batch runs many operations in one round-trip: parallel across libraries, in order within a library.
- fcp_xml_validate checks against Final Cut Pro's bundled DTD in ~50 ms with line numbers; fcp_xml_import validates first.
Constraints: paths must be absolute (or ~/...). Libraries open in the Final Cut Pro app are locked (error LIBRARY_LOCKED) for everything except library info; ask the user to close them. fcptool cannot edit timelines directly: to change a project, export FCPXML, edit it, validate, then import (conflictResolution "replace" or "keep-both").
Errors come back as {error:{code,message,hint}} with stable codes.`;

type Extra = { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };

function ctxFrom(extra: Extra): ops.Ctx {
  const token = extra._meta?.progressToken;
  let n = 0;
  return {
    signal: extra.signal,
    progress: token === undefined ? undefined : (message) => void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message } }).catch(() => undefined),
  };
}

function ok(data: unknown) {
  const obj = (data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data }) as Record<string, unknown>;
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }], structuredContent: obj };
}

function fail(e: unknown) {
  const error = e instanceof ToolError ? e.toJSON() : { code: 'FCPTOOL_ERROR', message: String((e as Error)?.message ?? e) };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error }) }], structuredContent: { error } };
}

const wrap =
  <A>(fn: (args: A, ctx: ops.Ctx) => Promise<unknown>) =>
  async (args: A, extra: any) => {
    try {
      return ok(await fn(args, ctxFrom(extra)));
    } catch (e) {
      return fail(e);
    }
  };

// ---- shared schema pieces
const libPath = z.string().describe('Absolute path to a .fcpbundle library (~/ allowed)');
const autoUpgrade = z.boolean().optional().describe('Upgrade an older-catalog library when opening it (fcptool --update). Irreversible for older Final Cut Pro versions.');
const fresh = z.boolean().optional().describe('Bypass the cache and re-read from fcptool');
const settingsShape = {
  colorProcessingMode: z.enum(['standard-gamut-sdr', 'wide-gamut-hdr', 'legacy-wide-gamut']).optional(),
  mediaLocation: z.string().optional().describe('"project" (inside the library) or an absolute folder path'),
  cacheLocation: z.string().optional().describe('"project" or an absolute folder path'),
  motionContentLocation: z.enum(['project', 'templates']).optional(),
  backupPolicy: z.string().optional().describe('"none", "default" (Final Cut Backups folder) or an absolute folder path'),
};
const docInput = {
  path: z.string().optional().describe('Absolute path to an .fcpxml file or .fcpxmld bundle'),
  xml: z.string().optional().describe('Inline FCPXML document text (instead of path)'),
};
const mediaShape = {
  withoutMedia: z.boolean().optional().describe('Copy without any media; clips may show as missing in the destination'),
  includeOriginalMedia: z.boolean().optional(),
  includeOptimizedMedia: z.boolean().optional(),
  includeProxyMedia: z.boolean().optional(),
  copyExternalMedia: z.boolean().optional().describe('Copy media stored outside the source library into the destination library'),
};
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function createServer(): McpServer {
  const server = new McpServer({ name: 'fcptool-mcp', title: 'Final Cut Pro (fcptool)', version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { logging: {} } });

  server.registerTool('fcp_status', {
    title: 'Final Cut Pro status',
    description: 'One call for the environment: fcptool path and version, catalog version, FCPXML export/validation versions, metadata view sets, whether Final Cut Pro is running and which libraries it has open (those are locked). Cached; fast after start-up.',
    inputSchema: { includeOpenLibraries: z.boolean().optional().describe('Default true') },
    annotations: RO,
  }, wrap((a: any) => ops.status(a)));

  server.registerTool('fcp_library_find', {
    title: 'Find libraries',
    description: 'Find .fcpbundle libraries on disk via Spotlight (falls back to a directory walk for unindexed folders) and report which are open in Final Cut Pro. No fcptool call, sub-second.',
    inputSchema: {
      scopes: z.array(z.string()).optional().describe('Absolute folders to search. Default: ~/Movies and ~'),
      includeBackups: z.boolean().optional().describe('Include Final Cut Backups. Default false'),
      checkOpen: z.boolean().optional().describe('Report openIn per library. Default true'),
    },
    annotations: RO,
  }, wrap((a: any) => ops.libraryFind(a)));

  server.registerTool('fcp_library_inspect', {
    title: 'Inspect library',
    description: 'Library info (catalog version, openability, dates), settings (color processing, media/cache/motion locations, backup policy) and events (with clip/project/still/audio counts) in one call. "info" works even when the library is open in Final Cut Pro. To see projects and clips inside events, use fcp_xml_export.',
    inputSchema: {
      path: libPath,
      include: z.array(z.enum(['info', 'settings', 'events'])).optional().describe('Default: all three'),
      fresh,
      autoUpgrade,
    },
    annotations: RO,
  }, wrap((a: any, c) => ops.libraryInspect(a.path, a.include, a, c)));

  server.registerTool('fcp_library_create', {
    title: 'Create library',
    description: 'Create a new empty library (.fcpbundle), optionally with named events and initial settings, in one call. Final Cut Pro also adds a default event named after today\'s date.',
    inputSchema: { path: libPath.describe('Absolute path for the new library; must end with .fcpbundle and not exist'), events: z.array(z.string()).optional(), settings: z.object(settingsShape).optional() },
    annotations: WRITE,
  }, wrap((a: any, c) => ops.libraryCreate(a.path, a, c)));

  server.registerTool('fcp_library_settings', {
    title: 'Library settings',
    description: 'Read library settings, or change them when any setting is given. Returns the list of changes ({setting, from, to}).',
    inputSchema: { path: libPath, ...settingsShape, autoUpgrade },
    annotations: { ...WRITE, idempotentHint: true },
  }, wrap((a: any, c) => {
    const { path, autoUpgrade, ...set } = a;
    return ops.librarySettings(path, set, { autoUpgrade }, c);
  }));

  server.registerTool('fcp_library_upgrade', {
    title: 'Upgrade library',
    description: 'Upgrade a library to the current catalog version. Older Final Cut Pro versions can no longer open it afterwards; check fcp_library_inspect openability first.',
    inputSchema: { path: libPath },
    annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
  }, wrap((a: any, c) => ops.libraryUpgrade(a.path, c)));

  server.registerTool('fcp_event_list', {
    title: 'List events',
    description: 'List events in a library with clip, project (timeline), still and audio counts. Cached until the library changes.',
    inputSchema: { path: libPath, fresh, autoUpgrade },
    annotations: RO,
  }, wrap((a: any, c) => ops.eventList(a.path, a, c)));

  server.registerTool('fcp_event_create', {
    title: 'Create events',
    description: 'Create one or more events in a library (one lock acquisition for all of them).',
    inputSchema: { path: libPath, names: z.array(z.string().min(1)).min(1), autoUpgrade },
    annotations: WRITE,
  }, wrap((a: any, c) => ops.eventCreate(a.path, a.names, a, c)));

  server.registerTool('fcp_event_copy', {
    title: 'Copy events between libraries',
    description: 'Copy events (by name) from one library to another, with control over which media comes along. Both libraries must be closed in Final Cut Pro. Sends progress notifications when the client provides a progressToken.',
    inputSchema: { from: libPath.describe('Source library'), to: libPath.describe('Destination library'), names: z.array(z.string().min(1)).min(1).describe('Event names to copy'), ...mediaShape, autoUpgrade },
    annotations: WRITE,
  }, wrap((a: any, c) => ops.eventCopy(a.from, a.to, a.names, a, a, c)));

  server.registerTool('fcp_xml_validate', {
    title: 'Validate FCPXML',
    description: 'Validate an FCPXML document (path or inline xml) against the DTD of its declared version, using the DTDs bundled in Final Cut Pro. engine "auto"/"fast" uses xmllint (~50 ms, errors with line numbers); "fcptool" uses fcptool xml validate (~2 s).',
    inputSchema: { ...docInput, engine: z.enum(['auto', 'fast', 'fcptool']).optional() },
    annotations: RO,
  }, wrap((a: any, c) => ops.xmlValidate(a, c)));

  server.registerTool('fcp_xml_inspect', {
    title: 'Inspect FCPXML',
    description: 'Parse an FCPXML document locally into a compact summary: formats, assets, events, projects (format, duration, timecode, storyline item counts, markers). detail "timeline" adds each project\'s spine items (type, name, offset/start/duration in seconds, lane, markers, keywords, effects, title text) and event clips; "full" adds all resources. No fcptool call.',
    inputSchema: { ...docInput, detail: z.enum(['summary', 'timeline', 'full']).optional(), maxItems: z.number().int().positive().optional().describe('Cap per list. Default 200') },
    annotations: RO,
  }, wrap((a: any) => ops.xmlInspect(a)));

  server.registerTool('fcp_xml_import', {
    title: 'Import FCPXML',
    description: 'Import an FCPXML/.fcpxmld (path or inline xml) into an existing library (into) or a new one (newLibrary). Validates against the DTD first and refuses invalid documents with line-numbered errors. conflictResolution decides what happens when an incoming item matches an existing one but differs: cancel (default: abort, library unchanged), keep-both, replace.',
    inputSchema: {
      ...docInput,
      into: z.string().optional().describe('Existing library to import into'),
      newLibrary: z.string().optional().describe('Path for a new .fcpbundle to create from the document'),
      conflictResolution: z.enum(['cancel', 'keep-both', 'replace']).optional(),
      validateFirst: z.boolean().optional().describe('Default true'),
      autoUpgrade,
    },
    annotations: WRITE,
  }, wrap((a: any, c) => ops.xmlImport(a, c)));

  server.registerTool('fcp_xml_export', {
    title: 'Export FCPXML',
    description: 'Export a whole library as FCPXML (.fcpxml) or an FCPXML bundle (.fcpxmld) and return a parsed summary of its events/projects/clips in the same call. output defaults to a temp file. This is how to read timeline contents; edit the exported XML and fcp_xml_import it to change projects.',
    inputSchema: {
      library: libPath,
      output: z.string().optional().describe('Absolute destination ending in .fcpxml or .fcpxmld; must not exist. Default: a temp file'),
      dtdVersion: z.string().optional().describe('FCPXML version to write (see fcp_status). Default: newest (1.15 in FCP 13.0)'),
      metadataView: z.string().optional().describe('Metadata view set whose fields are written (see fcp_status metadataViews)'),
      inspect: z.enum(['none', 'summary', 'timeline', 'full']).optional().describe('Summary detail to return. Default "summary"'),
      maxItems: z.number().int().positive().optional(),
      autoUpgrade,
    },
    annotations: { ...WRITE, readOnlyHint: false, idempotentHint: false },
  }, wrap((a: any, c) => ops.xmlExport(a, c)));

  server.registerTool('fcp_batch', {
    title: 'Batch operations',
    description: `Run many operations in one round-trip. Ops touching the same path run in the given order; ops on different libraries run in parallel (bounded process pool). Each result is {id, op, ok, ms, result | error}. op is one of: ${Object.keys(ops.batchable).join(', ')}; args are the same as the matching fcp_* tool (library_settings takes {path, set:{...}}).`,
    inputSchema: {
      operations: z.array(z.object({ op: z.enum(Object.keys(ops.batchable) as [string, ...string[]]), args: z.record(z.string(), z.any()), id: z.string().optional() })).min(1).max(100),
      stopOnError: z.boolean().optional().describe('Skip ops that have not started once one fails. Default false'),
    },
    annotations: WRITE,
  }, wrap((a: any, c) => ops.batch(a.operations, a, c)));

  // ---- resources
  server.registerResource('fcptool-reference', 'fcptool://reference', {
    title: 'fcptool reference (Final Cut Pro 13)',
    description: 'Complete command reference for fcptool with observed behaviour: JSON shapes, errors, locking, timing.',
    mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readFile(new URL('../docs/fcptool-reference.md', import.meta.url), 'utf8') }] }));

  server.registerResource('fcpxml-dtd', new ResourceTemplate('fcpxml://dtd/{version}', {
    list: async () => {
      const { app } = await locateFcptool();
      return { resources: (await availableDtds(app)).map((v) => ({ uri: `fcpxml://dtd/${v}`, name: `FCPXML ${v} DTD`, mimeType: 'application/xml-dtd' })) };
    },
  }), {
    title: 'FCPXML DTD',
    description: 'The FCPXML DTD bundled with the installed Final Cut Pro, by version (e.g. fcpxml://dtd/1.15). Read it before hand-writing FCPXML.',
    mimeType: 'application/xml-dtd',
  }, async (uri, vars) => {
    const { app } = await locateFcptool();
    const v = String(vars.version);
    if (!/^\d+\.\d+$/.test(v)) throw new Error(`bad version ${v}`);
    return { contents: [{ uri: uri.href, mimeType: 'application/xml-dtd', text: await readFile(dtdPath(app, v), 'utf8') }] };
  });

  return server;
}
