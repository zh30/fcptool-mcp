// Fast tests that need no Final Cut Pro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFcptoolError } from '../dist/errors.js';
import { KeyedLock, Semaphore } from '../dist/concurrency.js';
import { fcpTime, formatTimecode } from '../dist/fcpxml.js';
import { resolveUserPath } from '../dist/paths.js';

test('classifies real fcptool error texts', () => {
  const cases = {
    'Error: Library permissions error: /x/A.fcpbundle': 'LIBRARY_LOCKED',
    'Error: Unsupported library location open: /x/A.fcpbundle': 'ALREADY_EXISTS',
    'Error: The document is not a FCP library: /x/nope.fcpbundle\nFailed ... Code=260 "The file couldn’t be opened because there is no such file."': 'NOT_FOUND',
    'Error: Library event with name Nope was not found': 'NOT_FOUND',
    "Error: Invalid setting value 'foo'. Valid values: standard-gamut-sdr, wide-gamut-hdr, legacy-wide-gamut": 'INVALID_ARGUMENT',
    'Error: something new': 'FCPTOOL_ERROR',
  };
  for (const [text, code] of Object.entries(cases)) assert.equal(classifyFcptoolError(text).code, code, text);
});

test('KeyedLock: FIFO per key, parallel across keys, multi-key without deadlock', async () => {
  const lock = new KeyedLock();
  const log = [];
  const job = async (keys, name, ms) => {
    const release = await lock.acquire(keys);
    log.push(`+${name}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`-${name}`);
    release();
  };
  await Promise.all([job(['a'], 'a1', 30), job(['b'], 'b1', 30), job(['a', 'b'], 'ab', 10), job(['b', 'a'], 'ba', 10), job(['a'], 'a2', 1)]);
  assert.deepEqual(log.slice(0, 2).sort(), ['+a1', '+b1']); // independent keys start together
  assert.ok(log.indexOf('+ab') > log.indexOf('-a1') && log.indexOf('+ab') > log.indexOf('-b1'));
  assert.ok(log.indexOf('+ba') > log.indexOf('-ab'));
  assert.ok(log.indexOf('+a2') > log.indexOf('-ba'));
  assert.equal(lock.activeKeys, 0);
});

test('Semaphore caps concurrency', async () => {
  const s = new Semaphore(2);
  let cur = 0, peak = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    const r = await s.acquire();
    peak = Math.max(peak, ++cur);
    await new Promise((x) => setTimeout(x, 5));
    cur--;
    r();
  }));
  assert.equal(peak, 2);
});

test('FCPXML time values', () => {
  assert.equal(fcpTime('300/30s'), 10);
  assert.equal(fcpTime('1001/30000s'), 1001 / 30000);
  assert.equal(fcpTime('0s'), 0);
  assert.equal(fcpTime('bad'), undefined);
  assert.equal(formatTimecode(61.5, 30), '00:01:01:15');
});

test('paths must be absolute; ~ expands', () => {
  assert.throws(() => resolveUserPath('rel/x'), /absolute/);
  assert.match(resolveUserPath('~/Movies/A.fcpbundle'), /^\/.+\/Movies\/A\.fcpbundle$/);
  assert.equal(resolveUserPath('file:///tmp/My%20Lib.fcpbundle/'), '/tmp/My Lib.fcpbundle');
});
