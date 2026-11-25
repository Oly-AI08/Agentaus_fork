/* Agentaus PC companion client tests.
 *
 * Runs the client module against a real companion server and confirms the
 * status-to-error mapping the website relies on, plus the client's own
 * validation.  Run with:  node --test client.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startCompanion } from './server.mjs';

const require = createRequire(import.meta.url);
const {
  createClient,
  BadRequestError,
  NotAllowedError,
  NotFoundError,
  InvalidStateError,
  FileTooLargeError,
  isValidToken
} = require('./client.js');

let rootDir = '';
let stateDir = '';
let companion = null;
let client = null;

before(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentaus-client-root-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentaus-client-state-'));
  companion = await startCompanion({ roots: [rootDir], stateDir, port: 0 });
  client = createClient({ url: companion.url, token: companion.token });
});

after(() => {
  if (companion) companion.close();
  if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

test('the client performs health, write, list, stat, read and backups', async () => {
  const rootId = companion.app.roots[0].id;
  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.service, 'agentaus-pc-companion');
  assert.equal(health.version, 1);
  const made = await client.write(rootId, 'notes.txt', Buffer.from('one\n'));
  assert.equal(made.path, 'notes.txt');
  assert.match(made.sha256, /^[a-f0-9]{64}$/);
  const listing = await client.list(rootId, '');
  assert(listing.entries.some((e) => e.name === 'notes.txt'));
  const info = await client.read(rootId, 'notes.txt');
  assert.equal(Buffer.from(info.contentBase64, 'base64').toString(), 'one\n');
  assert.equal(info.sha256, made.sha256);
  const updated = await client.write(rootId, 'notes.txt', Buffer.from('two\n'), made.sha256);
  assert.match(updated.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(updated.sha256, made.sha256);
  const st = await client.stat(rootId, 'notes.txt');
  assert.equal(st.type, 'file');
  const backups = await client.backups(rootId);
  assert.equal(backups.backups.length, 2);
  assert(backups.backups.every((b) => /^[a-f0-9]{32}$/.test(b.id)));
  assert(backups.backups.every((b) => b.status === 'available'));
});

test('the client maps companion errors to the website error types', async () => {
  const rootId = companion.app.roots[0].id;
  const made = await client.write(rootId, 'v.txt', Buffer.from('v1'));
  assert.rejects(() => client.read(rootId, 'absent.txt'), NotFoundError);
  assert.rejects(() => client.undo(rootId, 'f'.repeat(32)), NotFoundError);
  assert.rejects(() => client.write(rootId, 'v.txt', Buffer.from('v3'), '0'.repeat(64)), InvalidStateError);
  await client.write(rootId, 'v.txt', Buffer.from('v2'), made.sha256);
});

test('the client rejects invalid requests before sending them', async () => {
  const rootId = companion.app.roots[0].id;
  assert.throws(() => client.read(rootId, '../escape.txt'), BadRequestError);
  assert.throws(() => client.read(rootId, 'x\\y.txt'), BadRequestError);
  assert.throws(() => client.undo(rootId, 'zz'), BadRequestError);
  assert.throws(() => client.list('no/slash'), BadRequestError);
  assert.throws(() => client.write(rootId, 'CON.txt', Buffer.from('x')), BadRequestError);
});

test('oversized files and wrong tokens surface as the documented errors', async () => {
  const rootId = companion.app.roots[0].id;
  /* The client refuses the oversized file before any request is sent, so the
   * error is a synchronous throw; wrap it so assert.rejects sees a rejection. */
  assert.rejects(async () => client.write(rootId, 'big.bin', Buffer.alloc(20 * 1024 * 1024 + 1)), FileTooLargeError);
  const stranger = createClient({ url: companion.url, token: 'a'.repeat(48) });
  assert.rejects(() => stranger.health(), NotAllowedError);
  assert.rejects(() => stranger.read(rootId, 'any.txt'), NotAllowedError);
  assert.equal(isValidToken('x'.repeat(48)), true);
  assert.equal(isValidToken('x'.repeat(31)), false);
  assert.equal(isValidToken('x'.repeat(513)), false);
  assert.equal(isValidToken('a b'), false);
  assert.equal(isValidToken('a\u0000b'), false);
});

test('the full backup and Undo cycle works through the client', async () => {
  const rootId = companion.app.roots[0].id;
  const one = await client.write(rootId, 'cycle.txt', Buffer.from('one'));
  await client.write(rootId, 'cycle.txt', Buffer.from('two'), one.sha256);
  const backups = await client.backups(rootId);
  const overwrite = backups.backups.find((b) => b.path === 'cycle.txt' && b.beforeExists);
  const result = await client.undo(rootId, overwrite.id);
  assert.equal(result.ok, true);
  const after = await client.read(rootId, 'cycle.txt');
  assert.equal(Buffer.from(after.contentBase64, 'base64').toString(), 'one');
  /* Undoing the same change twice must be refused as a version conflict. */
  await assert.rejects(() => client.undo(rootId, overwrite.id), InvalidStateError);
});
