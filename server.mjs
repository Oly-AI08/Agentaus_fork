#!/usr/bin/env node
'use strict';

/* Agentaus PC companion for the Agentaus website.
 *
 * This Node.js service implements the exact protocol that the Agentaus
 * website (the embedded companion client in app.js) already speaks.  The
 * contract lives in the website; this server side must match it byte for
 * byte:
 *
 *   GET  /v1/health                    -> {ok, service:'agentaus-pc-companion',
 *                                        version:1, roots:[{id,name,path}],
 *                                        maxFileBytes}
 *   GET  /v1/list?root=<id>&path=<rel> -> {entries:[{type,name,path}], truncated,
 *                                        skippedCount}
 *   GET  /v1/stat?root=<id>&path=<rel> -> {path, type, size, lastModified}
 *   POST /v1/read   {rootId, path}     -> {path, size, sha256, contentBase64,
 *                                        type, lastModified}
 *   POST /v1/write  {rootId, path, contentBase64, expectedSha256} -> {path, sha256}
 *   GET  /v1/backups?root=<id>         -> {backups:[{id, path, status, operation,
 *                                        beforeExists, beforeSize, afterSize,
 *                                        createdAt}]}
 *   POST /v1/undo  {rootId, backupId}  -> {ok:true}
 *
 * Errors are JSON objects of the form {error:{message, code}} with status
 * 400/401/403/404/409/413/500.  The browser maps the status to
 * NotAllowedError/NotFoundError/InvalidStateError, so the status codes and
 * messages matter.  Writes keep previous bytes in local backups and every
 * Undo first keeps a recovery backup.
 *
 * Node.js 22 or newer is required on the PC that runs the companion.
 */

import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 43127;
const SERVICE_NAME = 'agentaus-pc-companion';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ENCODED_BYTES = Math.ceil(MAX_FILE_BYTES / 3) * 4;
const MAX_BODY_BYTES = MAX_ENCODED_BYTES + 8192;
const ALLOWED_ENDPOINTS = new Set([
  '/v1/health',
  '/v1/list',
  '/v1/stat',
  '/v1/read',
  '/v1/write',
  '/v1/backups',
  '/v1/undo'
]);
const MAX_LIST_ENTRIES = 200;
const MAX_BACKUP_RECORDS = 100;
const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

const WINDOWS_PROTECTED = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
  'C:\\$Recycle.Bin', 'C:\\System Volume Information', 'C:\\Recovery', 'C:\\PerfLogs',
  'C:\\Users\\Default'
].map((entry) => entry.toLowerCase());

/* ------------------------------------------------------------------ *
 * Errors carry the status and machine code the website expects.          *
 * ------------------------------------------------------------------ */

function fail(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code || '';
  return error;
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Path validation - an exact mirror of the validation inside the          *
 * website's companion client.                                          *
 * ------------------------------------------------------------------ */

function pathParts(value, empty = false) {
  if (value === '' && empty) return [];
  if (typeof value !== 'string' || !value || value.length > 4096 ||
      /[\\\x00-\x1f\x7f<>:"|?*]/.test(value) ||
      value.startsWith('/') || value.endsWith('/')) {
    throw fail(400, 'Use a relative path inside the connected companion folder.', 'SecurityError');
  }
  const parts = value.split('/');
  if (parts.length > 64 || parts.some((part) =>
      !part || part === '.' || part === '..' || part !== part.trim() ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw fail(400, 'This path contains traversal, an invalid name, or a reserved filename.', 'SecurityError');
  }
  return parts;
}

function isValidToken(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 512 &&
    !/[\s]/.test(value) && !/[\x00-\x1f\x7f]/.test(value);
}

/* Normalize --origin values and Origin headers to "scheme://host[:port]".
 * A path in an --origin value is ignored so that approving
 * https://user.github.io/agentaus/ still approves https://user.github.io;
 * browsers never send a path in an Origin header. */
function normalizedOrigin(value) {
  if (typeof value !== 'string') return '';
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return '';
  }
  if (parsed.username || parsed.password) return '';
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') return '';
  const host = parsed.hostname ? parsed.hostname.toLowerCase() : '';
  if (!host || parsed.search || parsed.hash) return '';
  let origin = host;
  if (parsed.port) {
    const defaultPort = parsed.port === (scheme === 'https:' ? '443' : '80');
    if (!defaultPort) origin += ':' + parsed.port;
  }
  return scheme.slice(0, -1) + '://' + origin;
}

function decodeBase64(value) {
  if (typeof value !== 'string') throw fail(400, 'Invalid file data.', 'BadRequestError');
  if (value.length > MAX_ENCODED_BYTES) throw fail(413, 'The file exceeds the companion file limit.', 'FileTooLargeError');
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw fail(400, 'Invalid or oversize file data.', 'BadRequestError');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.slice(0, value.length - padding).includes('=')) throw fail(400, 'Malformed file data.', 'BadRequestError');
  const decoded = Buffer.from(value, 'base64');
  if (Buffer.from(decoded).toString('base64') !== value) throw fail(400, 'Malformed file data.', 'BadRequestError');
  if (decoded.length > MAX_FILE_BYTES) throw fail(413, 'The file exceeds the companion file limit.', 'FileTooLargeError');
  return decoded;
}

/* ------------------------------------------------------------------ *
 * Filesystem confinement                                              *
 * ------------------------------------------------------------------ */

function isWithin(candidate, base) {
  const relative = path.relative(base, candidate);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function isSymbolicLink(entry) {
  return Boolean(entry) && typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink();
}

function isJunction(entry) {
  return Boolean(entry) && typeof entry.isJunction === 'function' && entry.isJunction();
}

function statPath(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function protectedPrefixes() {
  if (process.platform !== 'win32') return [];
  return WINDOWS_PROTECTED;
}

function hasProtectedPrefix(candidate) {
  if (process.platform !== 'win32') return false;
  const lower = candidate.toLowerCase();
  return protectedPrefixes().some((prefix) => lower === prefix || lower.startsWith(prefix + path.sep));
}

/* Walk from `probe` up to the approved root and refuse the path when any
 * existing component is a symbolic link, a junction or a protected system
 * location.  `probe` is always built from the canonical root path. */
function assertPathUsable(root, probe) {
  let current = probe;
  for (let i = 0; i < 8192; i++) {
    const info = statPath(current);
    if (info && (isSymbolicLink(info) || isJunction(info))) {
      throw fail(403, 'Symbolic links, junctions and links outside the approved folder are excluded.', 'SecurityError');
    }
    if (current === root.realPath) break;
    const up = path.dirname(current);
    if (up === current) break;
    current = up;
  }
  if (hasProtectedPrefix(current)) {
    throw fail(403, 'This path is a protected system location.', 'SecurityError');
  }
}

function makeRoot(spec, takenIds, seenCanonical) {
  let real;
  try {
    real = fs.realpathSync(spec);
  } catch {
    throw new Error('The approved folder does not exist: ' + spec);
  }
  const key = process.platform === 'win32' ? real.toLowerCase() : real;
  if (seenCanonical.has(key)) throw new Error('The approved folder was already approved: ' + spec);
  seenCanonical.add(key);
  const info = statPath(real);
  if (!info || !info.isDirectory()) {
    throw new Error('The approved folder is not a directory: ' + spec);
  }
  if (isSymbolicLink(info) || isJunction(info)) {
    throw new Error('Symbolic links and junctions cannot be approved: ' + spec);
  }
  if (hasProtectedPrefix(real)) {
    throw new Error('This protected system path cannot be approved: ' + real);
  }
  const baseName = path.basename(real) || 'root';
  const cleaned = baseName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
  let id = cleaned.slice(0, 100);
  let candidate = id;
  for (let n = 2; takenIds.has(candidate); n++) {
    const suffix = '-' + n;
    candidate = id.slice(0, 100 - suffix.length) + suffix;
  }
  takenIds.add(candidate);
  return { id: candidate, name: baseName, path: real, realPath: real };
}

function withinRoot(root, rel) {
  const parts = pathParts(rel === undefined ? '' : rel, true);
  const joined = parts.length ? path.join(root.realPath, ...parts) : root.realPath;
  const existing = statPath(joined);
  if (existing) {
    if (isSymbolicLink(existing) || isJunction(existing)) {
      throw fail(403, 'Symbolic links, junctions and links outside the approved folder are excluded.', 'SecurityError');
    }
    assertPathUsable(root, joined);
    const realTarget = fs.realpathSync(joined);
    if (!isWithin(realTarget, root.realPath)) {
      throw fail(403, 'This path is outside the approved folder.', 'SecurityError');
    }
    if (hasProtectedPrefix(realTarget)) {
      throw fail(403, 'This path is a protected system location.', 'SecurityError');
    }
    return {
      realPath: realTarget,
      exists: true,
      isFile: existing.isFile(),
      size: existing.isFile() ? existing.size : 0,
      nlink: existing.nlink
    };
  }
  let up = path.dirname(joined);
  let previous = joined;
  let found = null;
  for (let i = 0; i < 4096 && previous !== up; i++) {
    if (statPath(up)) {
      found = up;
      break;
    }
    const next = path.dirname(up);
    if (next === up) break;
    previous = up;
    up = next;
  }
  if (found === null) {
    throw fail(403, 'This path is outside the approved folder.', 'SecurityError');
  }
  if (!isWithin(found, root.realPath)) {
    throw fail(403, 'This path is outside the approved folder.', 'SecurityError');
  }
  assertPathUsable(root, found);
  return { realPath: joined, exists: false, isFile: false, size: 0, nlink: 0 };
}

/* Publish `bytes` at `target` inside an approved folder.  New-file
 * publication uses a hard link (linkSync), which needs a filesystem that
 * supports hard links such as NTFS.  Replacing an existing single-linked
 * file falls back to an atomic rename where the platform allows it and
 * only then replaces via the hard link. */
function publishBytes(target, bytes) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, '.agentaus-publish-' + randomHex(12) + '.tmp');
  fs.writeFileSync(temp, bytes);
  try {
    try {
      fs.linkSync(temp, target);
    } catch (linkError) {
      try {
        fs.renameSync(temp, target);
      } catch (renameError) {
        fs.rmSync(target, { force: true });
        fs.linkSync(temp, target);
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      /* already moved */
    }
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* already moved */
    }
    throw fail(500, 'The companion could not publish the file. The approved filesystem may not support the hard links the companion needs.', 'NotSupportedError');
  }
}

/* ------------------------------------------------------------------ *
 * Local backup storage (per approved root)                           *
 * ------------------------------------------------------------------ */

function cleanRecord(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith('_')) out[key] = value;
  }
  return out;
}

function rootStateDir(stateDir, rootId) {
  return path.join(stateDir, 'roots', rootId);
}

function indexFile(stateDir, rootId) {
  return path.join(rootStateDir(stateDir, rootId), 'index.json');
}

function snapshotFile(stateDir, rootId, backupId) {
  return path.join(rootStateDir(stateDir, rootId), 'snapshots', backupId + '.snap');
}

function loadRecords(stateDir, rootId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(stateDir, rootId), 'utf8'));
    if (parsed && Array.isArray(parsed.records)) return parsed.records;
  } catch {
    /* first use */
  }
  return [];
}

function saveIndex(stateDir, rootId, records) {
  fs.mkdirSync(rootStateDir(stateDir, rootId), { recursive: true });
  const file = indexFile(stateDir, rootId);
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, records: records.map(cleanRecord) }));
  fs.renameSync(temp, file);
}

function writeSnapshot(stateDir, rootId, record) {
  if (!record.beforeExists) return;
  fs.mkdirSync(path.join(rootStateDir(stateDir, rootId), 'snapshots'), { recursive: true });
  const file = snapshotFile(stateDir, rootId, record.id);
  const temp = file + '.tmp';
  fs.writeFileSync(temp, record._beforeBytes !== undefined ? record._beforeBytes : Buffer.alloc(0));
  fs.renameSync(temp, file);
}

function removeSnapshot(stateDir, rootId, backupId) {
  try {
    fs.rmSync(snapshotFile(stateDir, rootId, backupId), { force: true });
  } catch {
    /* already gone */
  }
}

/* Keep the newest MAX_BACKUP_RECORDS and at most MAX_SNAPSHOT_BYTES of
 * previous-file snapshots per root, dropping the OLDEST records first. */
function pushRecord(stateDir, root, record) {
  writeSnapshot(stateDir, root.id, record);
  const records = loadRecords(stateDir, root.id);
  records.push(record);
  const kept = [];
  let bytes = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const item = records[i];
    if (kept.length >= MAX_BACKUP_RECORDS) {
      removeSnapshot(stateDir, root.id, item.id);
      continue;
    }
    if (item.beforeExists && bytes + (Number(item.beforeSize) || 0) > MAX_SNAPSHOT_BYTES) {
      removeSnapshot(stateDir, root.id, item.id);
      continue;
    }
    if (item.beforeExists) bytes += Number(item.beforeSize) || 0;
    kept.push(item);
  }
  kept.reverse();
  saveIndex(stateDir, root.id, kept);
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing                                                      *
 * ------------------------------------------------------------------ */

function originOf(req) {
  const value = req.headers.origin;
  return typeof value === 'string' ? value : '';
}

function originAllowed(app, header) {
  if (header === '' || header === 'null') return true;
  const value = normalizedOrigin(header);
  return value !== '' && (value === selfOrigin(app) || app.origins.includes(value));
}

function selfOrigin(app) {
  return 'http://127.0.0.1:' + app.boundPort;
}

/* The bound port of a listening net.Server is exposed as a property on newer
 * Node versions and as a method on older ones. Read either shape. */
function boundPortOf(server) {
  let info = null;
  try {
    info = typeof server.address === 'function' ? server.address() : server.address;
  } catch {
    info = null;
  }
  return info && Number.isInteger(info.port) ? info.port : 0;
}

function corsAllow(app, req) {
  const header = originOf(req);
  if (header === '' || header === 'null') return {};
  if (!originAllowed(app, header)) return {};
  return {
    'Access-Control-Allow-Origin': header,
    'Access-Control-Allow-Private-Network-Access': 'true'
  };
}

function byId(app, id) {
  return app.roots.find((root) => root.id === id) || null;
}

function send(app, req, res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
    ...corsAllow(app, req)
  });
  res.end(body);
}

function sendError(app, req, res, error) {
  if (res.headersSent || res.writableEnded) return;
  const status = error && Number.isInteger(error.status) && error.status >= 400 ? error.status : 500;
  const message = String((error && error.message) || 'Local companion request failed.');
  const code = String((error && error.code) || '');
  const body = Buffer.from(JSON.stringify({ error: { message, code } }));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
    ...corsAllow(app, req)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return; /* drain and discard the rest */
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(fail(413, 'The request body is too large.', 'FileTooLargeError'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (requestError) => {
      reject(requestError);
    });
  });
}

async function readJsonBody(req) {
  const text = (await readBody(req)).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail(400, 'Invalid request body.', 'BadRequestError');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail(400, 'Invalid request body.', 'BadRequestError');
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Static website                                                     *
 * ------------------------------------------------------------------ */

function staticFiles(app, req, res, pathname) {
  const names = {
    '/': 'Agentaus.html',
    '/Agentaus.html': 'Agentaus.html',
    '/app.js': 'app.js',
    '/styles.css': 'styles.css'
  };
  const file = names[pathname];
  if (!file) {
    send(app, req, res, 404, { error: { message: 'Not found.', code: 'NotFoundError' } });
    return;
  }
  let content;
  try {
    content = fs.readFileSync(path.join(PACKAGE_DIR, file));
  } catch {
    send(app, req, res, 404, { error: { message: 'Not found.', code: 'NotFoundError' } });
    return;
  }
  const type = file === 'Agentaus.html'
    ? 'text/html; charset=utf-8'
    : file === 'app.js'
      ? 'text/javascript; charset=utf-8'
      : 'text/css; charset=utf-8';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': content.length,
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
    ...corsAllow(app, req)
  });
  res.end(content);
}

async function handle(app, req, res) {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const pathname = parsed.pathname;
  const header = originOf(req);

  if (req.method === 'OPTIONS') {
    if (originAllowed(app, header)) {
      const headers = {
        'Content-Length': '0',
        'X-Content-Type-Options': 'nosniff',
        'Vary': 'Origin'
      };
      if (header !== '' && header !== 'null') {
        headers['Access-Control-Allow-Origin'] = header;
        headers['Access-Control-Allow-Private-Network-Access'] = 'true';
        headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
      }
      res.writeHead(204, headers);
      res.end();
    } else {
      res.writeHead(204, { 'Content-Length': '0', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' });
      res.end();
    }
    return;
  }

  if (header !== '' && header !== 'null' && !originAllowed(app, header)) {
    throw fail(403, 'This website is not approved for this companion.', 'NotAllowedError');
  }

  if (!ALLOWED_ENDPOINTS.has(pathname)) {
    staticFiles(app, req, res, pathname);
    return;
  }

  const authHeader = String(req.headers.authorization || '');
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  if (!match) throw fail(401, 'Pair the local companion before accessing files.', 'NotAllowedError');
  const given = match[1];
  const expected = Buffer.from(app.token);
  if (!isValidToken(given) || Buffer.from(given).length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(given), expected)) {
    throw fail(401, 'The pairing token is not valid for this companion run.', 'NotAllowedError');
  }

  const method = req.method || 'GET';

  if (pathname === '/v1/health') {
    if (method !== 'GET') throw fail(404, 'Not found.', 'NotFoundError');
    send(app, req, res, 200, {
      ok: true,
      service: SERVICE_NAME,
      version: 1,
      roots: app.roots.map((root) => ({ id: root.id, name: root.name, path: root.path })),
      maxFileBytes: MAX_FILE_BYTES
    });
    return;
  }

  if (pathname === '/v1/list') {
    if (method !== 'GET') throw fail(404, 'Not found.', 'NotFoundError');
    const params = new URLSearchParams(parsed.search);
    const root = byId(app, params.get('root') || '');
    if (!root) throw fail(403, 'This folder is not approved.', 'NotAllowedError');
    const rel = params.get('path') === null ? '' : params.get('path');
    const info = withinRoot(root, rel);
    if (!info.exists || info.isFile) throw fail(404, 'Folder not found.', 'NotFoundError');
    const names = fs.readdirSync(info.realPath, { withFileTypes: true });
    const entries = [];
    for (const dirent of names) {
      if (isSymbolicLink(dirent) || isJunction(dirent)) continue;
      try {
        pathParts(dirent.name);
      } catch {
        continue;
      }
      const link = statPath(path.join(info.realPath, dirent.name));
      if (!link || isSymbolicLink(link) || isJunction(link)) continue;
      if (link.isFile() && link.nlink > 1) continue;
      entries.push({ type: link.isFile() ? 'file' : 'directory', name: dirent.name, path: rel ? rel + '/' + dirent.name : dirent.name });
    }
    const truncated = entries.length > MAX_LIST_ENTRIES;
    send(app, req, res, 200, {
      entries: truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries,
      truncated,
      skippedCount: truncated ? entries.length - MAX_LIST_ENTRIES : 0
    });
    return;
  }

  if (pathname === '/v1/stat') {
    if (method !== 'GET') throw fail(404, 'Not found.', 'NotFoundError');
    const params = new URLSearchParams(parsed.search);
    const root = byId(app, params.get('root') || '');
    if (!root) throw fail(403, 'This folder is not approved.', 'NotAllowedError');
    const rel = params.get('path') === null ? '' : params.get('path');
    const info = withinRoot(root, rel);
    if (!info.exists) throw fail(404, 'Not found.', 'NotFoundError');
    const current = fs.statSync(info.realPath);
    send(app, req, res, 200, {
      path: rel,
      type: info.isFile ? 'file' : 'directory',
      size: info.isFile ? current.size : 0,
      lastModified: current.mtimeMs
    });
    return;
  }

  if (pathname === '/v1/backups') {
    if (method !== 'GET') throw fail(404, 'Not found.', 'NotFoundError');
    const params = new URLSearchParams(parsed.search);
    const root = byId(app, params.get('root') || '');
    if (!root) throw fail(403, 'This folder is not approved.', 'NotAllowedError');
    const backups = loadRecords(app.stateDir, root.id).map((record) => ({
      id: record.id,
      path: record.path,
      status: record.status,
      operation: record.operation,
      beforeExists: record.beforeExists,
      beforeSize: record.beforeSize,
      afterSize: record.afterSize,
      createdAt: record.createdAt
    }));
    send(app, req, res, 200, { backups });
    return;
  }

  if (pathname === '/v1/read') {
    if (method !== 'POST') throw fail(404, 'Not found.', 'NotFoundError');
    const body = await readJsonBody(req);
    const root = byId(app, typeof body.rootId === 'string' ? body.rootId : '');
    if (!root) throw fail(403, 'This folder is not approved.', 'NotAllowedError');
    if (typeof body.path !== 'string') throw fail(400, 'Invalid path.', 'BadRequestError');
    const info = withinRoot(root, body.path);
    if (!info.exists || !info.isFile) throw fail(404, 'File not found.', 'NotFoundError');
    if (info.size > MAX_FILE_BYTES) throw fail(413, 'The file exceeds the companion file limit.', 'FileTooLargeError');
    const data = fs.readFileSync(info.realPath);
    if (data.length > MAX_FILE_BYTES) throw fail(413, 'The file exceeds the companion file limit.', 'FileTooLargeError');
    send(app, req, res, 200, {
      path: body.path,
      size: data.length,
      sha256: sha256Hex(data),
      contentBase64: Buffer.from(data).toString('base64'),
      type: 'application/octet-stream',
      lastModified: fs.statSync(info.realPath).mtimeMs
    });
    return;
  }

  if (pathname === '/v1/write') {
    if (method !== 'POST') throw fail(404, 'Not found.', 'NotFoundError');
    const body = await readJsonBody(req);
    const root = byId(app, typeof body.rootId === 'string' ? body.rootId : '');
    if (!root) throw fail(403, 'This folder is not approved.', 'NotAllowedError');
    if (typeof body.path !== 'string') throw fail(400, 'Invalid path.', 'BadRequestError');
    const info = withinRoot(root, body.path);
    if (info.exists && !info.isFile) throw fail(409, 'This path is a folder, not a file.', 'InvalidStateError');
    if (info.exists && info.nlink > 1) {
      throw fail(403, 'This file has multiple hard links and is excluded.', 'SecurityError');
    }
    const expected = body.expectedSha256 === undefined || body.expectedSha256 === null ? null : body.expectedSha256;
    if (expected !== null && typeof expected !== 'string') throw fail(400, 'Invalid expected file version.', 'BadRequestError');
    const before = info.exists ? fs.readFileSync(info.realPath) : null;
    if (info.exists && sha256Hex(before) !== expected) {
      throw fail(409, 'The file changed after it was read. Refresh the file before trying again.', 'InvalidStateError');
    }
    if (!info.exists && expected !== null) {
      throw fail(409, 'The file is missing. Refresh the file before trying again.', 'InvalidStateError');
    }
    if (typeof body.contentBase64 !== 'string') throw fail(400, 'Invalid file data.', 'BadRequestError');
    const bytes = decodeBase64(body.contentBase64);
    const newSha = sha256Hex(bytes);
    publishBytes(info.realPath, bytes);
    const record = {
      id: randomHex(16),
      rootId: root.id,
      path: body.path,
      operation: 'write',
      beforeExists: info.exists,
      beforeSize: before ? before.length : 0,
      beforeSha256: before ? sha256Hex(before) : null,
      afterSha256: newSha,
      afterSize: bytes.length,
      afterExists: true,
      createdAt: Date.now(),
      status: 'available',
      _beforeBytes: before
    };
    pushRecord(app.stateDir, root, record);
    send(app, req, res, 200, { path: body.path, size: bytes.length, sha256: newSha });
    return;
  }

  if (pathname === '/v1/undo') {
    if (method !== 'POST') throw fail(404, 'Not found.', 'NotFoundError');
    const body = await readJsonBody(req);
    const root = byId(app, typeof body.rootId === 'string' ? body.rootId : '');
    if (!root) throw fail(403, 'This folder is not approved.', 'NotAllowedError');
    if (typeof body.backupId !== 'string' || !/^[a-f0-9]{32}$/.test(body.backupId)) {
      throw fail(400, 'Invalid backup identifier.', 'BadRequestError');
    }
    const records = loadRecords(app.stateDir, root.id);
    const record = records.find((item) => item.id === body.backupId);
    if (!record) throw fail(404, 'This saved change is no longer available.', 'NotFoundError');
    if (record.status !== 'available') throw fail(409, 'This change was already undone.', 'InvalidStateError');
    const info = withinRoot(root, record.path);
    if (info.exists && !info.isFile) throw fail(409, 'This path is a folder, not a file.', 'InvalidStateError');
    if (info.exists && info.nlink > 1) {
      throw fail(403, 'This file has multiple hard links and is excluded.', 'SecurityError');
    }
    const current = info.exists ? fs.readFileSync(info.realPath) : null;
    if (record.afterExists) {
      if (current === null) throw fail(409, 'The file is missing. Refresh the file before trying again.', 'InvalidStateError');
      if (sha256Hex(current) !== record.afterSha256) {
        throw fail(409, 'The file changed after this save. Refresh the file before trying again.', 'InvalidStateError');
      }
    } else if (current !== null) {
      throw fail(409, 'The file was recreated after this change. Refresh the file before trying again.', 'InvalidStateError');
    }
    const beforeBytes = record.beforeExists
      ? fs.readFileSync(snapshotFile(app.stateDir, root.id, body.backupId))
      : null;
    const recovery = {
      id: randomHex(16),
      rootId: root.id,
      path: record.path,
      operation: 'undo',
      beforeExists: record.afterExists,
      beforeSize: record.afterSize,
      beforeSha256: record.afterSha256,
      afterExists: record.beforeExists,
      afterSize: record.beforeSize,
      afterSha256: record.beforeSha256,
      createdAt: Date.now(),
      status: 'available',
      _beforeBytes: current
    };
    if (record.beforeExists) {
      publishBytes(info.realPath, beforeBytes);
    } else if (info.exists) {
      fs.rmSync(info.realPath, { force: true });
    }
    pushRecord(app.stateDir, root, recovery);
    const afterRecords = loadRecords(app.stateDir, root.id);
    const mark = afterRecords.find((item) => item.id === body.backupId);
    if (mark) mark.status = 'undone';
    saveIndex(app.stateDir, root.id, afterRecords);
    send(app, req, res, 200, { ok: true });
    return;
  }

  throw fail(404, 'Not found.', 'NotFoundError');
}

function makeHandler(app) {
  return (req, res) => {
    handle(app, req, res).catch((error) => sendError(app, req, res, error));
  };
}

/* ------------------------------------------------------------------ *
 * Companion application                                            *
 * ------------------------------------------------------------------ */

function createCompanionApp(options = {}) {
  const seenCanonical = new Set();
  const takenIds = new Set();
  const app = {
    roots: [],
    origins: (Array.isArray(options.origins) ? options.origins : []).map(normalizedOrigin).filter(Boolean),
    stateDir: typeof options.stateDir === 'string' && options.stateDir
      ? options.stateDir
      : path.join(os.tmpdir(), 'agentaus-pc-companion'),
    token: isValidToken(options.token) ? options.token : randomHex(24),
    port: Number.isInteger(options.port) ? options.port : 0,
    boundPort: 0
  };
  const specs = Array.isArray(options.roots) ? options.roots : [];
  for (const spec of specs) {
    if (typeof spec !== 'string' || spec === '') throw new Error('A --root value is missing.');
    app.roots.push(makeRoot(spec, takenIds, seenCanonical));
  }
  if (app.roots.length === 0) {
    throw new Error('At least one approved folder is required. Use --root to approve a folder, or run "node server.mjs --help".');
  }
  return { app };
}

function helpText() {
  return [
    'Agentaus PC companion for the Agentaus website',
    '',
    'Usage: node server.mjs [options]',
    '',
    '  --root <folder>    Approve a folder. Repeat this option to approve several.',
    '                    Example: --root "C:\\Users\\YourName\\Documents"',
    '  --origin <origin>  Website origin this companion accepts (protocol and host only,',
    '                    for example https://your-username.github.io). Requests from',
    '                    other websites are refused. The local agentaus app is always allowed.',
    '  --port <port>      Local port to listen on. Default: ' + DEFAULT_PORT + '.',
    '  --state-dir <dir>   Directory for local backups. Default: a private folder in the',
    '                    system temp directory for this user.',
    '  --help             Show this help text.',
    '',
    'Example:',
    '  node server.mjs --origin https://your-username.github.io --root "C:\\Users\\YourName\\Documents"',
    '',
    ''
  ].join('\n');
}

/* Start a companion and resolve with {token, port, url, app, close}.
 * Pass port:0 to choose a free local port (used by the tests). */
function startCompanion(options = {}) {
  const { app } = createCompanionApp(options);
  const port = Number.isInteger(options.port) && options.port !== 0 ? options.port : 0;
  if (port !== 0 && (port < 1024 || port > 65535)) {
    return Promise.reject(new Error('Use a local port from 1024 to 65535.'));
  }
  const server = createServer(makeHandler(app));
  app.boundPort = port || 0;
  return new Promise((resolve, reject) => {
    server.on('error', (error) => reject(error));
    server.listen(port === 0 ? 0 : port, '127.0.0.1', () => {
      app.boundPort = boundPortOf(server);
      resolve({
        token: app.token,
        port: app.boundPort,
        url: 'http://127.0.0.1:' + app.boundPort,
        app,
        close: () => {
          try {
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
          } catch {
            /* older runtimes omit the connection helpers */
          }
          try {
            server.close();
          } catch {
            /* already closing */
          }
        }
      });
    });
  }).catch((error) => {
    server.close();
    throw error;
  });
}

function parseArgv(argv) {
  const opts = { roots: [], origins: [], port: undefined, stateDir: '' };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--root') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value === '') {
        throw new Error('--root expects a folder path. For example: --root "C:\\Users\\YourName\\Documents"');
      }
      opts.roots.push(value);
      i++;
      continue;
    }
    if (arg === '--origin') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value === '') {
        throw new Error('--origin expects a website origin. For example: --origin https://your-username.github.io');
      }
      opts.origins.push(value);
      i++;
      continue;
    }
    if (arg === '--port') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) {
        throw new Error('Use a local port from 1024 to 65535.');
      }
      opts.port = value;
      i++;
      continue;
    }
    if (arg === '--state-dir') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value === '') {
        throw new Error('--state-dir expects a directory path. For example: --state-dir "C:\\Users\\YourName\\companion-backups"');
      }
      opts.stateDir = value;
      i++;
      continue;
    }
    throw new Error('Unknown option: ' + arg);
  }
  return opts;
}

function main(argv) {
  const opts = parseArgv(argv);
  if (opts.help) {
    process.stdout.write(helpText());
    return;
  }
  const args = {
    roots: opts.roots,
    origins: opts.origins,
    port: opts.port === undefined ? DEFAULT_PORT : opts.port,
    stateDir: opts.stateDir
  };
  const { app } = createCompanionApp(args);
  const server = createServer(makeHandler(app));
  process.once('SIGINT', () => {
    console.log('\nCompanion stopped. Closing it stops local access.');
    process.exit(0);
  });
  process.once('SIGTERM', () => process.exit(0));
  server.on('error', (error) => {
    console.error('The companion could not listen on port ' + (opts.port === undefined ? DEFAULT_PORT : opts.port) + ': ' + error.message);
    console.error('Check that no other companion is already using that port, or choose another port with --port.');
    console.error('Run "node server.mjs --help" for the available options.');
    process.exit(1);
  });
  server.listen(opts.port === undefined ? DEFAULT_PORT : opts.port, '127.0.0.1', () => {
    const port = boundPortOf(server);
    app.boundPort = port;
    console.log('Agentaus PC companion is running on this PC.');
    console.log('  Local app  : http://127.0.0.1:' + port + '/');
    console.log('  Approved folders:');
    for (const root of app.roots) {
      console.log('    ' + root.id + '  ->  ' + root.path);
    }
    if (app.origins.length) {
      console.log('  Approved website origin(s): ' + app.origins.join(', '));
    }
    console.log('  Backups   : ' + app.stateDir);
    console.log('');
    console.log('A new pairing token is generated for this run:');
    console.log('    ' + app.token);
    console.log('');
    console.log('Open http://127.0.0.1:' + port + '/ in Chrome or Edge on this PC.');
    console.log('In the app, choose Files -> PC companion, paste the pairing token,');
    console.log('select the approved folder and connect.');
    console.log('');
    console.log('A new pairing token is generated when this companion restarts.');
    console.log('Keep this window open. Closing it stops local access.');
  });
}

export {
  startCompanion,
  createCompanionApp,
  pathParts,
  normalizedOrigin,
  decodeBase64,
  isValidToken,
  DEFAULT_PORT,
  MAX_FILE_BYTES
};

/* Run directly?  `node server.mjs --origin ... --root ...` starts the
 * companion so that the documented commands work.  When the module is
 * imported by the tests, only the exports are used. */
const directModule =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (directModule) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(String((error && error.message) || error));
    process.exit(1);
  }
}
