// End-to-end: MCP client -> fcptool-mcp (stdio) -> real fcptool. Needs Final Cut Pro 13 installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.join(here, 'fixtures/agent-cut.fcpxml');
const hasFcp = existsSync(process.env.FCPTOOL_PATH ?? '/Applications/Final Cut Pro.app/Contents/MacOS/fcptool');
const opts = { skip: !hasFcp && 'Final Cut Pro 13 not installed', timeout: 180_000 };

let client, dir;
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, data: r.structuredContent };
};

before(async () => {
  if (!hasFcp) return;
  dir = await mkdtemp(path.join(tmpdir(), 'fcptool-mcp-e2e-'));
  client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, '../dist/index.js')], stderr: 'ignore' }));
});
after(async () => {
  await client?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('lists tools and resources', opts, async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ['fcp_status', 'fcp_library_find', 'fcp_library_inspect', 'fcp_library_create', 'fcp_library_settings', 'fcp_library_upgrade', 'fcp_event_list', 'fcp_event_create', 'fcp_event_copy', 'fcp_xml_validate', 'fcp_xml_inspect', 'fcp_xml_import', 'fcp_xml_export', 'fcp_batch'])
    assert.ok(names.includes(n), n);
  assert.ok(tools.find((t) => t.name === 'fcp_status').annotations.readOnlyHint);
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === 'fcptool://reference'));
  const tpl = await client.listResourceTemplates();
  assert.ok(tpl.resourceTemplates.some((t) => t.uriTemplate === 'fcpxml://dtd/{version}'));
  const dtd = await client.readResource({ uri: 'fcpxml://dtd/1.15' });
  assert.match(dtd.contents[0].text, /<!ELEMENT fcpxml/);
  const ref = await client.readResource({ uri: 'fcptool://reference' });
  assert.match(ref.contents[0].text, /fcptool/);
});

test('status reports versions', opts, async () => {
  const { data } = await call('fcp_status');
  assert.match(data.fcptool.appVersion, /^13\./);
  assert.ok(data.fcpxml.exportVersions.includes('1.15'));
  assert.ok(data.metadataViews.some((v) => v.name === 'General'));
  assert.equal(typeof data.finalCutPro.running, 'boolean');
});

test('create, inspect (cached), settings', opts, async () => {
  const lib = path.join(dir, 'One.fcpbundle');
  const c = await call('fcp_library_create', { path: lib, events: ['Dailies', 'Selects'], settings: { backupPolicy: 'none' } });
  assert.ok(!c.isError, JSON.stringify(c.data));
  assert.deepEqual(c.data.eventsCreated, ['Dailies', 'Selects']);

  const i1 = await call('fcp_library_inspect', { path: lib });
  assert.equal(i1.data.info.openability, 'compatible');
  assert.equal(i1.data.settings.backupPolicy.policy, 'noBackups');
  assert.deepEqual(i1.data.events.map((e) => e.name).filter((n) => n !== 'Dailies' && n !== 'Selects').length, 1);

  const t = Date.now();
  const i2 = await call('fcp_library_inspect', { path: lib });
  assert.ok(Date.now() - t < 500, 'second inspect should be served from cache');
  assert.deepEqual(i2.data.cached.sort(), ['events', 'info', 'settings']);

  const s = await call('fcp_library_settings', { path: lib, colorProcessingMode: 'wide-gamut-hdr' });
  assert.equal(s.data.changes[0].to, 'wideGamutHDR');
  const i3 = await call('fcp_library_inspect', { path: lib, include: ['settings'] });
  assert.equal(i3.data.settings.colorProcessingMode, 'wideGamutHDR', 'write must invalidate cache');
});

test('fast validation with line numbers', opts, async () => {
  const bad = (await readFile(FIXTURE, 'utf8')).replace('<resources>', '<resources><bogus/>');
  const t = Date.now();
  const v = await call('fcp_xml_validate', { xml: bad });
  assert.ok(Date.now() - t < 1000);
  assert.equal(v.data.valid, false);
  assert.equal(v.data.engine, 'xmllint');
  assert.ok(v.data.errors.some((e) => e.line === 4));
  const ok = await call('fcp_xml_validate', { path: FIXTURE });
  assert.equal(ok.data.valid, true);
  const slow = await call('fcp_xml_validate', { xml: bad, engine: 'fcptool' });
  assert.equal(slow.data.valid, false, 'fcptool agrees');
});

test('import -> export round trip with timeline summary', opts, async () => {
  const lib = path.join(dir, 'Two.fcpbundle');
  const imp = await call('fcp_xml_import', { path: FIXTURE, newLibrary: lib });
  assert.ok(!imp.isError, JSON.stringify(imp.data));
  const ev = await call('fcp_event_list', { path: lib });
  const mcp = ev.data.events.find((e) => e.name === 'MCP Test');
  assert.equal(mcp.timelineCount, 1);

  const out = path.join(dir, 'two.fcpxml');
  const ex = await call('fcp_xml_export', { library: lib, output: out, inspect: 'timeline' });
  assert.ok(!ex.isError, JSON.stringify(ex.data));
  const proj = ex.data.contents.libraries[0].events.find((e) => e.name === 'MCP Test').projects[0];
  assert.equal(proj.name, 'Agent Cut');
  assert.equal(proj.duration, 10);
  assert.equal(proj.format.fps, 30);
  assert.equal(proj.spine.length, 2);
  assert.equal(proj.spine[0].connected[0].text, 'Hello from MCP');
  assert.equal(proj.spine[0].markers[0].value, 'Beat 1');

  const again = await call('fcp_xml_export', { library: lib, output: out });
  assert.equal(again.data.error.code, 'ALREADY_EXISTS');
});

test('errors are structured', opts, async () => {
  const rel = await call('fcp_library_inspect', { path: 'relative/Lib.fcpbundle' });
  assert.equal(rel.isError, true);
  assert.equal(rel.data.error.code, 'INVALID_ARGUMENT');
  const missing = await call('fcp_event_list', { path: path.join(dir, 'Nope.fcpbundle') });
  assert.equal(missing.data.error.code, 'NOT_FOUND');
  const bad = await call('fcp_xml_import', { xml: '<?xml version="1.0"?><fcpxml version="1.15"><nope/></fcpxml>', into: path.join(dir, 'One.fcpbundle') });
  assert.equal(bad.data.error.code, 'VALIDATION_FAILED');
  assert.ok(bad.data.error.details.errors.length > 0);
  const copy = await call('fcp_event_copy', { from: path.join(dir, 'One.fcpbundle'), to: path.join(dir, 'Two.fcpbundle'), names: ['Missing'] });
  assert.equal(copy.data.error.code, 'NOT_FOUND');
});

test('parallel calls on one library are serialized instead of failing', opts, async () => {
  // Raw fcptool: 3 of 4 concurrent opens of one library fail with "Library permissions error".
  const lib = path.join(dir, 'One.fcpbundle');
  const rs = await Promise.all([1, 2, 3, 4].map(() => call('fcp_event_list', { path: lib, fresh: true })));
  for (const r of rs) assert.ok(!r.isError, JSON.stringify(r.data));
});

test('batch: dependent ops ordered, independent ops parallel', opts, async () => {
  const a = path.join(dir, 'BA.fcpbundle'), b = path.join(dir, 'BB.fcpbundle');
  const r = await call('fcp_batch', {
    operations: [
      { id: 'a', op: 'library_create', args: { path: a, events: ['E1'] } },
      { id: 'b', op: 'library_create', args: { path: b } },
      { id: 'ia', op: 'xml_import', args: { path: FIXTURE, into: a } },
      { id: 'copy', op: 'event_copy', args: { from: a, to: b, names: ['MCP Test'] } },
      { id: 'list', op: 'event_list', args: { path: b } },
    ],
    stopOnError: true,
  });
  assert.ok(r.data.ok, JSON.stringify(r.data));
  const list = r.data.results.find((x) => x.id === 'list').result.events.map((e) => e.name);
  assert.ok(list.includes('MCP Test'));
  const sum = r.data.results.reduce((s, x) => s + x.ms, 0);
  assert.ok(r.data.ms < sum, `batch wall time ${r.data.ms} ms should be below the sum of op times ${sum} ms`);
});

test('library_find walks unindexed folders and reports open state', opts, async () => {
  const r = await call('fcp_library_find', { scopes: [dir] });
  const names = r.data.libraries.map((l) => l.name).sort();
  assert.ok(names.includes('One') && names.includes('Two'));
  assert.ok(Array.isArray(r.data.libraries[0].openIn));
});

test('libraries open in Final Cut Pro report LIBRARY_LOCKED with a hint', opts, async (t) => {
  const { data } = await call('fcp_status');
  const open = data.finalCutPro.openLibraries[0];
  if (!open) return t.skip('Final Cut Pro has no library open');
  const r = await call('fcp_event_list', { path: open, fresh: true });
  assert.equal(r.data.error.code, 'LIBRARY_LOCKED');
  assert.match(r.data.error.hint, /Final Cut Pro/);
  const info = await call('fcp_library_inspect', { path: open, include: ['info'] });
  assert.ok(!info.isError, 'library info still works on an open library');
});
