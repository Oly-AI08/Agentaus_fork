#!/usr/bin/env node
'use strict';

/* Agentaus PC companion client
 *
 * Talk to a running companion (server.mjs) from Node.  The website's embedded
 * companion client defines the protocol; this module mirrors its requests and
 * its status-to-error mapping so the terminal behaves the same way the browser
 * does.  The companion errors carry JSON
 *
 *     { "error": { "message": "...", "code": "..." } }
 *
 * and this client maps:
 *
 *     400 -> BadRequestError   401/403 -> NotAllowedError   404 -> NotFoundError
 *     409 -> InvalidStateError 413 -> FileTooLargeError     other -> CompanionError
 *
 * Usage (node --check client.js validates this file):
 *
 *   node client.js --url http://127.0.0.1:43127/ --token <token> health
 *   node client.js --url http://127.0.0.1:43127/ --token <token> list <rootId> [path]
 *   node client.js --url http://127.0.0.1:43127/ --token <token> stat <rootId> <path>
 *   node client.js --url http://127.0.0.1:43127/ --token <token> read <rootId> <path> [--out <file>]
 *   node client.js --url http://127.0.0.1:43127/ --token <token> write <rootId> <path> --file <local-file> [--expect <sha256>]
 *   node client.js --url http://127.0.0.1:43127/ --token <token> backups <rootId>
 *   node client.js --url http://127.0.0.1:43127/ --token <token> undo <rootId> <backupId>
 */

const nodeHttp = require('node:http');
const fs = require('node:fs');

const DEFAULT_URL = 'http://127.0.0.1:43127/';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

class CompanionError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code || '';
  }
}
class BadRequestError extends CompanionError {}
class NotAllowedError extends CompanionError {}
class NotFoundError extends CompanionError {}
class InvalidStateError extends CompanionError {}
class FileTooLargeError extends CompanionError {}

const ERROR_TYPES = {
  400: BadRequestError,
  401: NotAllowedError,
  403: NotAllowedError,
  404: NotFoundError,
  409: InvalidStateError,
  413: FileTooLargeError
};

function isValidToken(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 512 &&
    !/[\s]/.test(value) && !/[\x00-\x1f\x7f]/.test(value);
}

/* Path names must satisfy the same rules the website enforces before it sends a
 * request.  The server re-checks every request; these checks fail fast and
 * keep the terminal client consistent with the browser. */
function validatePath(value, allowEmpty = false) {
  if (value === '' && allowEmpty) return;
  if (typeof value !== 'string' || !value || value.length > 4096 ||
      /[\\\x00-\x1f\x7f<>:"|?*]/.test(value) ||
      value.startsWith('/') || value.endsWith('/')) {
    throw new BadRequestError('Use a relative path inside the connected companion folder.', 400, 'SecurityError');
  }
  const parts = value.split('/');
  if (parts.length > 64 || parts.some((part) =>
      !part || part === '.' || part === '..' || part !== part.trim() ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new BadRequestError('This path contains traversal, an invalid name, or a reserved filename.', 400, 'SecurityError');
  }
  return parts;
}

function validateRootId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new BadRequestError('This folder is not approved.', 400, 'NotAllowedError');
  }
}

function validateBackupId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
    throw new BadRequestError('Invalid backup identifier.', 400, 'BadRequestError');
  }
}

function requestFrom(client, method, pathname, { query = {}, json } = {}) {
  if (!isValidToken(client.token)) {
    throw new BadRequestError('Pair the local companion before accessing files.', 400, 'NotAllowedError');
  }
  return new Promise((resolve, reject) => {
    const url = new URL(client.url);
    url.pathname = pathname;
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    /* Settle exactly once: a server reset racing a completed response must not
     * surface as a second rejection after the caller has moved on. */
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const timeoutError = () => new CompanionError('The companion did not answer within ' + client.timeoutMs + ' ms.', 0, 'TimeoutError');
    const req = nodeHttp.request(url, { method, agent: false, headers: { 'Authorization': 'Bearer ' + client.token } }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        let payload = {};
        try {
          payload = JSON.parse(chunks.join(''));
        } catch {
          payload = {};
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          finish(resolve, payload);
          return;
        }
        const message = payload && payload.error && typeof payload.error.message === 'string'
          ? payload.error.message
          : 'Local companion request failed.';
        const code = payload && payload.error && typeof payload.error.code === 'string'
          ? payload.error.code
          : '';
        finish(reject, new (ERROR_TYPES[res.statusCode] || CompanionError)(message, res.statusCode, code));
      });
    });
    req.on('error', (requestError) => {
      clearTimeout(timer);
      finish(reject, requestError);
    });
    if (json !== undefined) req.write(JSON.stringify(json));
    const timer = setTimeout(() => {
      const error = timeoutError();
      try {
        req.destroy(error);
      } catch {
        try {
          req.destroy();
        } catch {
          /* already destroyed */
        }
      }
      finish(reject, error);
    }, client.timeoutMs);
    req.end();
  });
}

function createClient(options = {}) {
  const client = {
    url: typeof options.url === 'string' && options.url ? options.url : DEFAULT_URL,
    token: typeof options.token === 'string' ? options.token : '',
    timeoutMs: Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000
  };
  return {
    health: () => requestFrom(client, 'GET', '/v1/health'),
    list: (rootId, relPath = '') => {
      validateRootId(rootId);
      validatePath(relPath, true);
      return requestFrom(client, 'GET', '/v1/list', { query: { root: rootId, path: relPath } });
    },
    stat: (rootId, relPath) => {
      validateRootId(rootId);
      validatePath(relPath);
      return requestFrom(client, 'GET', '/v1/stat', { query: { root: rootId, path: relPath } });
    },
    read: (rootId, relPath) => {
      validateRootId(rootId);
      validatePath(relPath);
      return requestFrom(client, 'POST', '/v1/read', { json: { rootId, path: relPath } });
    },
    write: (rootId, relPath, content, expectedSha256) => {
      validateRootId(rootId);
      validatePath(relPath);
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new FileTooLargeError('The file exceeds the companion file limit.', 413, 'FileTooLargeError');
      }
      const json = { rootId, path: relPath, contentBase64: bytes.toString('base64') };
      if (expectedSha256 !== undefined && expectedSha256 !== null) json.expectedSha256 = expectedSha256;
      return requestFrom(client, 'POST', '/v1/write', { json });
    },
    backups: (rootId) => {
      validateRootId(rootId);
      return requestFrom(client, 'GET', '/v1/backups', { query: { root: rootId } });
    },
    undo: (rootId, backupId) => {
      validateRootId(rootId);
      validateBackupId(backupId);
      return requestFrom(client, 'POST', '/v1/undo', { json: { rootId, backupId } });
    }
  };
}

function usage() {
  return [
    'Agentaus PC companion client',
    '',
    'Usage: node client.js [--url http://127.0.0.1:43127/] [--token <token>] <command> [args]',
    '',
    '  --url <url>      The local companion address. Default: ' + DEFAULT_URL,
    '  --token <token>  The pairing token printed by the companion window.',
    '  --timeout <ms>   Request timeout in milliseconds. Default: 30000.',
    '',
    'Commands:',
    '  health',
    '  list <rootId> [path]',
    '  stat <rootId> <path>',
    '  read <rootId> <path> [--out <file>]   Save the file bytes to <file>.',
    '  write <rootId> <path> --file <local>  [--expect <sha256>]',
    '  backups <rootId>',
    '  undo <rootId> <backupId>',
    '',
    'Errors are printed as JSON: {"error":{"message":"...","code":"..."}}'
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { url: DEFAULT_URL, token: '', timeoutMs: 30000, file: '', out: '', expectSha: '', help: false };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' || arg === '--token' || arg === '--timeout' || arg === '--file' || arg === '--out' || arg === '--expect') {
      const value = argv[i + 1];
      if (value === undefined || value === '') throw new CompanionError('Missing a value after ' + arg, 0, 'UsageError');
      if (arg === '--url') opts.url = value;
      else if (arg === '--token') opts.token = value;
      else if (arg === '--timeout') opts.timeoutMs = Number(value);
      else if (arg === '--file') opts.file = value;
      else if (arg === '--out') opts.out = value;
      else opts.expectSha = value;
      i++;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    rest.push(arg);
  }
  opts.command = rest[0] || '';
  opts.rest = rest.slice(1);
  return opts;
}

async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const client = createClient({ url: opts.url, token: opts.token, timeoutMs: opts.timeoutMs });
  const rest = opts.rest;
  let result;
  switch (opts.command) {
    case 'health':
      result = await client.health();
      break;
    case 'list':
      result = await client.list(rest[0], rest[1] !== undefined ? rest[1] : '');
      break;
    case 'stat':
      result = await client.stat(rest[0], rest[1]);
      break;
    case 'read': {
      const data = await client.read(rest[0], rest[1]);
      if (opts.out !== '') {
        const bytes = Buffer.from(data.contentBase64, 'base64');
        fs.writeFileSync(opts.out, bytes);
        result = { path: data.path, size: data.size, sha256: data.sha256, type: data.type, lastModified: data.lastModified, savedTo: opts.out };
      } else {
        result = data;
      }
      break;
    }
    case 'write':
      result = await client.write(rest[0], rest[1], fs.readFileSync(opts.file), opts.expectSha === '' ? undefined : opts.expectSha);
      break;
    case 'backups':
      result = await client.backups(rest[0]);
      break;
    case 'undo':
      result = await client.undo(rest[0], rest[1]);
      break;
    default:
      throw new CompanionError('Unknown command: ' + opts.command, 0, 'UsageError');
  }
  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  createClient,
  CompanionError,
  BadRequestError,
  NotAllowedError,
  NotFoundError,
  InvalidStateError,
  FileTooLargeError,
  isValidToken,
  DEFAULT_URL
};

if (require.main === module) {
  run(process.argv).then(
    () => process.exit(0),
    (error) => {
      const status = Number.isInteger(error && error.status) && error.status >= 400 ? error.status : 1;
      const payload = { error: { message: String((error && error.message) || error), code: error && error.code ? error.code : '' } };
      process.stderr.write(JSON.stringify(payload) + '\n');
      process.exit(status);
    }
  );
}
