/* Agentaus PC companion server tests.
 *
 * Exercises the documented companion contract through its real HTTP layer:
 * health, authorization and key/token handling, path boundaries, file creation
 * and editing, backups and Undo, and the advertised retention limits.
 *
 * Run with:  node --test server.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  startCompanion,
  createCompanionApp,
  pathParts,
  normalizedOrigin,
  isValidToken,
  MAX_FILE_BYTES
} from './server.mjs';

const MAX_ENCODED_BYTES = Math.ceil(MAX_FILE_BYTES / 3) * 4;
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

let roots = [];
let stateDir = '';
let companion = null;

before(async () => {
  roots = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'agentaus-root-a-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'agentaus-root-b-'))
  ];
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentaus-state-'));
  companion = await startCompanion({ roots, stateDir, port: 0, origins: ['https://oly-ai08.github.io'] });
});

after(() => {
  if (companion) companion.close();
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

function rootA() { return companion.app.roots[0]; }
function rootB() { return companion.app.roots[1]; }
function b64(bytes) { return Buffer.from(bytes).toString('base64'); }

async function raw(endpoint, { method = 'GET', token = companion.token, origin = null, json } = {}) {
  const headers = {};
  if (token !== null && token !== undefined) headers.Authorization = 'Bearer ' + token;
  if (origin !== null) headers.Origin = origin;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(companion.url + endpoint, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* non-JSON body (static file or 204) */ }
  return { status: res.status, data, headers: res.headers };
}

function writeRaw(rootId, relPath, bytes, expectedSha) {
  const json = { rootId, path: relPath, contentBase64: b64(bytes) };
  if (expectedSha !== undefined) json.expectedSha256 = expectedSha;
  return raw('/v1/write', { method: 'POST', json });
}

function readRaw(rootId, relPath) {
  return raw('/v1/read', { method: 'POST', json: { rootId, path: relPath } });
}

function backupsRaw(rootId) {
  return raw('/v1/backups?root=' + encodeURIComponent(rootId));
}

test('health reports the companion service, version and approved roots', async () => {
  const r = await raw('/v1/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.service, 'agentaus-pc-companion');
  assert.equal(r.data.version, 1);
  assert.equal(r.data.maxFileBytes, MAX_FILE_BYTES);
  assert.equal(r.data.roots.length, 2);
  assert.equal(r.data.roots[0].id, rootA().id);
  assert.equal(r.data.roots[1].id, rootB().id);
});

test('requests without a token or with an invalid token are refused', async () => {
  assert.equal((await raw('/v1/health', { token: null })).status, 401);
  assert.equal((await raw('/v1/health', { token: 'a'.repeat(48) })).status, 401);
  assert.equal((await raw('/v1/health', { token: 'a b' })).status, 401);
  assert.equal((await raw('/v1/backups?root=' + rootA().id)).status, 200);
  assert.equal((await raw('/v1/list?root=zzz&path=')).status, 403);
  assert.equal(isValidToken(companion.token), true);
  assert.equal(companion.token.length, 48);
});

test('pathParts accepts valid relative paths and rejects invalid names', () => {
  assert.deepEqual(pathParts('a/b/c.txt'), ['a', 'b', 'c.txt']);
  assert.deepEqual(pathParts('', true), []);
  for (const bad of ['..', '.', 'a/../b', '/abs', 'abs/', 'a\\\\b', 'con', 'CON.txt', 'nul', 'a.', 'a ', 'x:y', 'x>y', Array(65).fill('d').join('/'), 'a//b', 'a\u0000b']) {
    assert.throws(() => pathParts(bad), /relative path|traversal/, JSON.stringify(bad));
  }
  assert.throws(() => pathParts('x'.repeat(4097)), /relative path/);
});

test('createCompanionApp requires at least one approved folder', () => {
  assert.throws(() => createCompanionApp({ roots: [], stateDir }), /At least one approved folder/);
});

test('normalizedOrigin keeps scheme, host and non-default port and drops paths', () => {
  assert.equal(normalizedOrigin('https://user.github.io/agentaus/'), 'https://user.github.io');
  assert.equal(normalizedOrigin('https://user.github.io'), 'https://user.github.io');
  assert.equal(normalizedOrigin('http://127.0.0.1:43127'), 'http://127.0.0.1:43127');
  assert.equal(normalizedOrigin('https://USER.GITHUB.IO:443'), 'https://user.github.io');
  assert.equal(normalizedOrigin('javascript:alert(1)'), '');
  assert.equal(normalizedOrigin('https://user:pass@host.example.com'), '');
  assert.equal(normalizedOrigin(''), '');
});

test('the API enforces path boundaries', async () => {
  for (const bad of ['../escape.txt', 'a/../b', '/abs', 'a\\\\b.txt', 'con.txt', 'a.', 'x:y.txt', Array(65).fill('d').join('/')]) {
    const r = await readRaw(rootA().id, bad);
    assert.equal(r.status, 400, bad);
  }
  fs.mkdirSync(path.join(roots[0], 'folderish'));
  const w = await writeRaw(rootA().id, 'folderish', Buffer.from('x'));
  assert.equal(w.status, 409);
  assert.equal(w.data.error.code, 'InvalidStateError');
  assert.equal((await raw('/v1/list?root=' + rootA().id + '&path=../x')).status, 400);
});

test('files can be created, listed, checked and read back', async () => {
  fs.mkdirSync(path.join(roots[0], 'docs'), { recursive: true });
  const w = await writeRaw(rootA().id, 'docs/intro.txt', Buffer.from('hello world\n'));
  assert.equal(w.status, 200);
  assert.equal(w.data.path, 'docs/intro.txt');
  assert.equal(w.data.size, 12);
  assert.match(w.data.sha256, /^[a-f0-9]{64}$/);
  assert.equal(w.data.sha256, sha256Hex(Buffer.from('hello world\n')));
  const rd = await readRaw(rootA().id, 'docs/intro.txt');
  assert.equal(rd.status, 200);
  assert.equal(rd.data.path, 'docs/intro.txt');
  assert.equal(rd.data.sha256, w.data.sha256);
  assert.equal(rd.data.contentBase64, b64(Buffer.from('hello world\n')));
  const stFile = await raw('/v1/stat?root=' + rootA().id + '&path=docs/intro.txt');
  assert.equal(stFile.status, 200);
  assert.equal(stFile.data.type, 'file');
  const stDir = await raw('/v1/stat?root=' + rootA().id + '&path=docs');
  assert.equal(stDir.status, 200);
  assert.equal(stDir.data.type, 'directory');
  const lst = await raw('/v1/list?root=' + rootA().id + '&path=docs');
  assert.equal(lst.status, 200);
  assert.equal(lst.data.truncated, false);
  assert.deepEqual(lst.data.entries.map((e) => e.name).filter((n) => n === 'intro.txt'), ['intro.txt']);
  assert.equal((await raw('/v1/list?root=' + rootA().id + '&path=docs/intro.txt')).status, 404);
  assert.equal((await readRaw(rootA().id, 'docs/absent.bin')).status, 404);
  assert.equal((await raw('/v1/stat?root=' + rootA().id + '&path=missing')).status, 404);
});

test('writes are version-checked before existing files are replaced', async () => {
  const v1 = Buffer.from('v1');
  const v2 = Buffer.from('v2');
  const made = await writeRaw(rootA().id, 'notes.txt', v1);
  assert.equal(made.status, 200);
  const outdated = await writeRaw(rootA().id, 'notes.txt', v2, '0'.repeat(64));
  assert.equal(outdated.status, 409);
  assert.equal(outdated.data.error.code, 'InvalidStateError');
  const good = await writeRaw(rootA().id, 'notes.txt', v2, made.data.sha256);
  assert.equal(good.status, 200);
  assert.equal(fs.readFileSync(path.join(roots[0], 'notes.txt')).toString(), 'v2');
  const invisible = await writeRaw(rootA().id, 'fresh.txt', v2, '0'.repeat(64));
  assert.equal(invisible.status, 409);
  assert.equal((await readRaw(rootA().id, 'notes.txt')).data.contentBase64, b64(v2));
});

test('backups keep previous bytes and Undo restores them with recovery backups', async () => {
  const v1 = Buffer.from('first');
  const v2 = Buffer.from('second');
  const made = await writeRaw(rootA().id, 'backed.txt', v1);
  const up = await writeRaw(rootA().id, 'backed.txt', v2, made.data.sha256);
  assert.equal(up.status, 200);
  const all = await backupsRaw(rootA().id);
  assert.equal(all.status, 200);
  assert.equal(all.data.backups.filter((b) => b.path === 'backed.txt').length, 2);
  const overwrite = all.data.backups.find((b) => b.path === 'backed.txt' && b.beforeExists);
  const created = all.data.backups.find((b) => b.path === 'backed.txt' && !b.beforeExists);

  const kick = await raw('/v1/undo', { method: 'POST', json: { rootId: rootA().id, backupId: overwrite.id } });
  assert.equal(kick.status, 200);
  assert.equal(fs.readFileSync(path.join(roots[0], 'backed.txt')).toString(), 'first');
  const afterUndo = await backupsRaw(rootA().id);
  assert.equal(afterUndo.data.backups.find((b) => b.id === overwrite.id).status, 'undone');
  const recovery = afterUndo.data.backups.find((b) => b.path === 'backed.txt' && b.operation === 'undo');
  assert(recovery);

  const replay = await raw('/v1/undo', { method: 'POST', json: { rootId: rootA().id, backupId: overwrite.id } });
  assert.equal(replay.status, 409);

  const remove = await raw('/v1/undo', { method: 'POST', json: { rootId: rootA().id, backupId: created.id } });
  assert.equal(remove.status, 200);
  assert.equal(fs.existsSync(path.join(roots[0], 'backed.txt')), false);

  const afterRemove = await backupsRaw(rootA().id);
  const redo = afterRemove.data.backups.find((b) => b.operation === 'undo' && b.beforeExists && b.afterSize === 0);
  assert(redo, 'undoing the creation must leave a recovery backup of the removed bytes');
  const restore = await raw('/v1/undo', { method: 'POST', json: { rootId: rootA().id, backupId: redo.id } });
  assert.equal(restore.status, 200);
  assert.equal(fs.readFileSync(path.join(roots[0], 'backed.txt')).toString(), 'first');

  assert.equal((await raw('/v1/undo', { method: 'POST', json: { rootId: rootA().id, backupId: 'f'.repeat(32) } })).status, 404);
  assert.equal((await raw('/v1/undo', { method: 'POST', json: { rootId: rootA().id, backupId: 'zz' } })).status, 400);
});

test('backup history is capped at 100 records per root', async () => {
  const names = Array.from({ length: 105 }, (_, i) => 'small' + String(i).padStart(3, '0') + '.txt');
  for (const name of names) {
    const r = await writeRaw(rootA().id, name, Buffer.from('x'));
    assert.equal(r.status, 200);
  }
  const keep = await backupsRaw(rootA().id);
  assert.equal(keep.data.backups.length, 100);
  for (let i = 0; i < 5; i++) {
    assert(!keep.data.backups.some((b) => b.path === names[i]), names[i] + ' should have been pruned');
  }
});

test('snapshots are capped at 200 MiB per root', async () => {
  /* rootB keeps this test self-contained: 11 creates leave no snapshot, each of
   * the 11 overwrites snapshots 20 MiB - 1 bytes, and the oldest snapshot plus
   * its record is pruned once 11 x (20 MiB - 1) exceeds 200 MiB. */
  const big = Buffer.alloc(20 * 1024 * 1024 - 1);
  const names = Array.from({ length: 11 }, (_, i) => 'big' + String(i).padStart(3, '0') + '.bin');
  for (const name of names) {
    const made = await writeRaw(rootB().id, name, big);
    assert.equal(made.status, 200);
  }
  for (const name of names) {
    const rd = await readRaw(rootB().id, name);
    assert.equal(rd.status, 200);
    const up = await writeRaw(rootB().id, name, Buffer.from('z'), rd.data.sha256);
    assert.equal(up.status, 200);
  }
  const keep = await backupsRaw(rootB().id);
  assert.equal(keep.data.backups.length, 21, '11 creates plus 10 of 11 overwrite records survive the byte cap');
  const snapDir = path.join(stateDir, 'roots', rootB().id, 'snapshots');
  const snaps = fs.readdirSync(snapDir).filter((n) => n.endsWith('.snap'));
  assert.equal(snaps.length, 10, '10 snapshots of 20 MiB - 1 fit under 200 MiB, the 11th prunes the oldest');
});

test('large listings are truncated at 200 entries', async () => {
  fs.mkdirSync(path.join(roots[0], 'many'), { recursive: true });
  for (let i = 0; i < 205; i++) {
    const r = await writeRaw(rootA().id, 'many/e' + String(i).padStart(3, '0') + '.txt', Buffer.from('e'));
    assert.equal(r.status, 200);
  }
  const lst = await raw('/v1/list?root=' + rootA().id + '&path=many');
  assert.equal(lst.status, 200);
  assert.equal(lst.data.entries.length, 200);
  assert.equal(lst.data.truncated, true);
  assert.equal(lst.data.skippedCount, 5);
});

test('symbolic links to the outside are excluded and refused', async () => {
  try {
    fs.symlinkSync(path.join(roots[0], 'real.txt'), path.join(roots[0], 'link.txt'));
  } catch {
    assert.fail('could not create a test symlink');
  }
  const lst = await raw('/v1/list?root=' + rootA().id + '&path=');
  assert(!lst.data.entries.some((e) => e.name === 'link.txt'));
  const rd = await readRaw(rootA().id, 'link.txt');
  assert.equal(rd.status, 403);
  const w = await writeRaw(rootA().id, 'link.txt/esc.txt', Buffer.from('x'));
  assert.equal(w.status, 403);
  fs.unlinkSync(path.join(roots[0], 'link.txt'));
});

test('multiply hard-linked files are excluded and refused', async () => {
  const shared = path.join(roots[1], 'shared.txt');
  fs.writeFileSync(shared, 'shared');
  fs.linkSync(shared, path.join(roots[1], 'twin.txt'));
  const lst = await raw('/v1/list?root=' + rootB().id + '&path=');
  assert(!lst.data.entries.some((e) => e.name === 'twin.txt'));
  assert.equal((await writeRaw(rootB().id, 'twin.txt', Buffer.from('x'))).status, 403);
  assert.equal((await readRaw(rootB().id, 'b-only.txt')).status, 404);
});

test('requires a body for POST endpoints and validates base64', async () => {
  assert.equal((await raw('/v1/read', { method: 'POST', json: null })).status, 400);
  assert.equal((await raw('/v1/write', { method: 'POST', json: {} })).status, 403);
  const tooBig = await raw('/v1/write', { method: 'POST', json: { rootId: rootA().id, path: 'huge.bin', contentBase64: 'A'.repeat(MAX_ENCODED_BYTES + 8) } });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.data.error.code, 'FileTooLargeError');
  assert.equal((await raw('/v1/write', { method: 'POST', json: { rootId: rootA().id, path: 'x.txt', contentBase64: 'not-base64!!!' } })).status, 400);
  const file = await writeRaw(rootA().id, 'x.txt', Buffer.from('hello world\n'));
  assert.equal(file.status, 200);
  assert.equal(fs.readFileSync(path.join(roots[0], 'x.txt')).toString(), 'hello world\n');
});

test('the website origin allowlist is enforced', async () => {
  const denied = await raw('/v1/health', { origin: 'https://evil.example.com' });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, 'NotAllowedError');
  const allowed = await raw('/v1/health', { origin: 'https://oly-ai08.github.io' });
  assert.equal(allowed.status, 200);
  const variant = await raw('/v1/health', { origin: 'https://oly-ai08.github.io/agentaus/' });
  assert.equal(variant.status, 200);
  const preflight = await raw('/v1/health', { origin: 'https://oly-ai08.github.io', method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://oly-ai08.github.io');
});

test('serves the local website and answers unknown endpoints with 404', async () => {
  const home = await raw('/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
  const js = await raw('/app.js');
  assert.equal(js.status, 200);
  const css = await raw('/styles.css');
  assert.equal(css.status, 200);
  assert.equal((await raw('/v1/nope')).status, 404);
  const health = await raw('/v1/health');
  assert.equal(health.status, 200);
});
