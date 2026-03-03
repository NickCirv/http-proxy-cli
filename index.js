#!/usr/bin/env node
/**
 * http-proxy-cli — Local HTTP proxy with real-time request/response inspection
 * Zero external dependencies. Node 18+. ES modules.
 */

import http from 'http';
import https from 'https';
import net from 'net';
import { URL } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import readline from 'readline';

// ─── ANSI colours ─────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
};

const METHOD_COLOUR = {
  GET:     C.green,
  POST:    C.blue,
  PUT:     C.yellow,
  PATCH:   C.magenta,
  DELETE:  C.red,
  HEAD:    C.cyan,
  OPTIONS: C.gray,
  CONNECT: C.white,
};

function colourMethod(method) {
  return (METHOD_COLOUR[method] ?? C.white) + C.bold + method + C.reset;
}

function colourStatus(code) {
  if (code >= 500) return C.red    + code + C.reset;
  if (code >= 400) return C.yellow + code + C.reset;
  if (code >= 300) return C.cyan   + code + C.reset;
  if (code >= 200) return C.green  + code + C.reset;
  return code;
}

// ─── Auth header redaction ─────────────────────────────────────────────────────
function redactAuthHeader(value) {
  if (!value) return value;
  const parts = value.split(' ');
  if (parts.length >= 2) {
    const scheme = parts[0];
    const token  = parts[1];
    const visible = token.slice(0, 8);
    return `${scheme} ${visible}... [redacted]`;
  }
  // single-token style
  return value.slice(0, 8) + '... [redacted]';
}

function sanitiseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === 'authorization' || k.toLowerCase() === 'proxy-authorization') {
      out[k] = redactAuthHeader(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function timestamp() {
  return new Date().toISOString();
}

function tryParseBody(buf, contentType) {
  if (!buf || buf.length === 0) return null;
  const ct = (contentType ?? '').split(';')[0].trim();
  if (ct === 'application/json' || ct === 'text/json') {
    try { return JSON.parse(buf.toString('utf8')); } catch { /* fall through */ }
  }
  if (ct.startsWith('text/') || ct === 'application/x-www-form-urlencoded') {
    return buf.toString('utf8');
  }
  return `<binary ${formatBytes(buf.length)}>`;
}

function prettyBody(body, indent = 2) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'object') return JSON.stringify(body, null, indent);
  return String(body);
}

// ─── Logging sink ─────────────────────────────────────────────────────────────
class Logger {
  constructor(opts) {
    this.inspect  = opts.inspect  ?? false;
    this.logFile  = opts.logFile  ?? null;
    this.filter   = opts.filter   ?? null;
    this._stream  = null;

    if (this.logFile) {
      this._stream = fs.createWriteStream(this.logFile, { flags: 'a' });
    }
  }

  _matchesFilter(path) {
    if (!this.filter) return true;
    return path.includes(this.filter);
  }

  log(entry) {
    if (!this._matchesFilter(entry.path)) return;
    this._toTerminal(entry);
    if (this._stream) {
      this._stream.write(JSON.stringify(entry) + '\n');
    }
  }

  _toTerminal(e) {
    const ms     = e.durationMs != null ? `${e.durationMs}ms` : '—';
    const size   = e.responseSize != null ? formatBytes(e.responseSize) : '—';
    const method = colourMethod(e.method);
    const status = e.status ? colourStatus(e.status) : C.gray + 'TUNNEL' + C.reset;
    const path   = C.white + e.path + C.reset;
    const timing = C.gray  + ms + C.reset;
    const sz     = C.gray  + size + C.reset;
    const ts     = C.dim   + e.timestamp.slice(11, 23) + C.reset;

    process.stdout.write(`${ts}  ${method.padEnd(18)} ${status}  ${timing.padEnd(12)} ${sz.padEnd(12)}  ${path}\n`);

    if (this.inspect) {
      if (e.requestHeaders && Object.keys(e.requestHeaders).length > 0) {
        process.stdout.write(C.dim + '  ↑ headers: ' + JSON.stringify(sanitiseHeaders(e.requestHeaders)) + C.reset + '\n');
      }
      if (e.requestBody) {
        process.stdout.write(C.blue + '  ↑ body:\n' + prettyBody(e.requestBody).split('\n').map(l => '    ' + l).join('\n') + C.reset + '\n');
      }
      if (e.responseHeaders && Object.keys(e.responseHeaders).length > 0) {
        process.stdout.write(C.dim + '  ↓ headers: ' + JSON.stringify(sanitiseHeaders(e.responseHeaders)) + C.reset + '\n');
      }
      if (e.responseBody) {
        process.stdout.write(C.green + '  ↓ body:\n' + prettyBody(e.responseBody).split('\n').map(l => '    ' + l).join('\n') + C.reset + '\n');
      }
      process.stdout.write('\n');
    }
  }

  close() {
    if (this._stream) this._stream.end();
  }
}

// ─── Proxy server ─────────────────────────────────────────────────────────────
function buildProxy(opts) {
  const target       = new URL(opts.target);
  const logger       = new Logger(opts);
  const injectHeader = opts.injectHeader ?? null; // { name, value }

  const server = http.createServer((req, res) => {
    const id        = crypto.randomUUID();
    const startMs   = Date.now();
    const reqChunks = [];

    req.on('data', chunk => reqChunks.push(chunk));
    req.on('end',  () => {
      const reqBody = Buffer.concat(reqChunks);

      const targetHost = target.hostname;
      const targetPort = target.port || (target.protocol === 'https:' ? 443 : 80);
      const isHttps    = target.protocol === 'https:';

      const headers = { ...req.headers };
      headers['host'] = targetHost + (target.port ? `:${target.port}` : '');

      if (injectHeader) {
        headers[injectHeader.name] = injectHeader.value;
      }

      // Remove hop-by-hop headers
      for (const h of ['proxy-connection', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']) {
        delete headers[h];
      }

      const options = {
        hostname: targetHost,
        port:     targetPort,
        path:     req.url,
        method:   req.method,
        headers,
      };

      const forward = isHttps ? https.request : http.request;

      const proxyReq = forward(options, proxyRes => {
        const resChunks = [];
        proxyRes.on('data', chunk => resChunks.push(chunk));
        proxyRes.on('end', () => {
          const durationMs   = Date.now() - startMs;
          const resBody      = Buffer.concat(resChunks);
          const responseSize = resBody.length;

          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(resBody);

          const entry = {
            id,
            timestamp:    timestamp(),
            method:       req.method,
            path:         req.url,
            status:       proxyRes.statusCode,
            durationMs,
            responseSize,
            requestHeaders:  req.headers,
            responseHeaders: proxyRes.headers,
            requestBody:     opts.inspect ? tryParseBody(reqBody, req.headers['content-type'])      : undefined,
            responseBody:    opts.inspect ? tryParseBody(resBody, proxyRes.headers['content-type']) : undefined,
          };

          logger.log(entry);
        });
      });

      proxyReq.on('error', err => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Proxy error: ${err.message}`);
        process.stderr.write(`${C.red}[proxy error]${C.reset} ${err.message}\n`);
      });

      if (reqBody.length > 0) proxyReq.write(reqBody);
      proxyReq.end();
    });
  });

  // CONNECT tunnel (HTTPS passthrough)
  server.on('connect', (req, clientSocket, head) => {
    const [host, rawPort] = req.url.split(':');
    const port = parseInt(rawPort ?? '443', 10);
    const startMs = Date.now();

    const serverSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: http-proxy-cli\r\n\r\n');
      if (head && head.length > 0) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', err => {
      process.stderr.write(`${C.red}[tunnel error]${C.reset} ${host}:${port} — ${err.message}\n`);
      clientSocket.destroy();
    });

    clientSocket.on('close', () => {
      const durationMs = Date.now() - startMs;
      logger.log({
        id:        crypto.randomUUID(),
        timestamp: timestamp(),
        method:    'CONNECT',
        path:      req.url,
        status:    null,
        durationMs,
        responseSize: null,
        requestHeaders:  {},
        responseHeaders: {},
      });
      serverSocket.destroy();
    });
  });

  return { server, logger };
}

// ─── Replay ───────────────────────────────────────────────────────────────────
async function replay(logFile, opts) {
  if (!fs.existsSync(logFile)) {
    process.stderr.write(`${C.red}Error:${C.reset} log file not found: ${logFile}\n`);
    process.exit(1);
  }

  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  if (entries.length === 0) {
    process.stderr.write(`${C.red}Error:${C.reset} no valid NDJSON entries found in ${logFile}\n`);
    process.exit(1);
  }

  let toReplay;
  if (opts.index != null) {
    if (opts.index < 0 || opts.index >= entries.length) {
      process.stderr.write(`${C.red}Error:${C.reset} index ${opts.index} out of range (0–${entries.length - 1})\n`);
      process.exit(1);
    }
    toReplay = [entries[opts.index]];
  } else {
    toReplay = entries;
  }

  const targetBase = opts.target ?? 'http://localhost:8080';

  process.stdout.write(`${C.bold}Replaying ${toReplay.length} request(s) → ${targetBase}${C.reset}\n\n`);

  for (const entry of toReplay) {
    const target = new URL(entry.path, targetBase);
    const isHttps = target.protocol === 'https:';

    const headers = { ...(entry.requestHeaders ?? {}) };
    headers['host'] = target.hostname;
    // Redact outgoing auth for display only — do not modify actual value
    for (const h of ['content-length', 'transfer-encoding']) delete headers[h];

    const bodyStr = entry.requestBody ? JSON.stringify(entry.requestBody) : undefined;
    if (bodyStr) headers['content-length'] = Buffer.byteLength(bodyStr).toString();

    await new Promise(resolve => {
      const options = {
        hostname: target.hostname,
        port:     target.port || (isHttps ? 443 : 80),
        path:     target.pathname + target.search,
        method:   entry.method,
        headers,
      };

      const startMs = Date.now();
      const req = (isHttps ? https : http).request(options, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const ms   = Date.now() - startMs;
          const body = Buffer.concat(chunks);
          process.stdout.write(
            `${colourMethod(entry.method).padEnd(18)} ${colourStatus(res.statusCode)}  ${C.gray}${ms}ms${C.reset}  ${C.gray}${formatBytes(body.length)}${C.reset}  ${C.white}${entry.path}${C.reset}\n`
          );
          resolve();
        });
      });

      req.on('error', err => {
        process.stderr.write(`${C.red}replay error:${C.reset} ${err.message}\n`);
        resolve();
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  process.stdout.write(`\n${C.green}Done.${C.reset}\n`);
}

// ─── Header parser ─────────────────────────────────────────────────────────────
function parseInjectHeader(raw) {
  const idx = raw.indexOf(':');
  if (idx === -1) {
    process.stderr.write(`${C.red}Error:${C.reset} --inject-header must be "Name: Value"\n`);
    process.exit(1);
  }
  return {
    name:  raw.slice(0, idx).trim().toLowerCase(),
    value: raw.slice(idx + 1).trim(),
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function printHelp() {
  process.stdout.write(`
${C.bold}http-proxy-cli${C.reset} — Local HTTP proxy with real-time inspection

${C.bold}USAGE${C.reset}
  http-proxy-cli start [options]
  http-proxy-cli replay <log-file> [options]

${C.bold}START OPTIONS${C.reset}
  --port <n>              Proxy listen port            (default: 8080)
  --target <url>          Forward requests to URL      (default: http://localhost:3000)
  --inspect               Pretty-print request/response bodies
  --log <file>            Save entries to NDJSON file
  --filter <string>       Only log paths containing string
  --inject-header <h>     Add header to all requests   (e.g. "X-Debug: true")

${C.bold}REPLAY OPTIONS${C.reset}
  --target <url>          Replay to this base URL      (default: http://localhost:8080)
  --index <n>             Replay only entry at index n (0-based)

${C.bold}EXAMPLES${C.reset}
  http-proxy-cli start
  http-proxy-cli start --port 9000 --target http://api.example.com
  http-proxy-cli start --inspect --log requests.log --filter /api
  http-proxy-cli start --inject-header "X-Debug: true"
  http-proxy-cli replay requests.log
  http-proxy-cli replay requests.log --index 3 --target http://localhost:3000

${C.bold}ALIASES${C.reset}
  hproxy start ...
  hproxy replay ...

${C.bold}SECURITY${C.reset}
  Authorization headers are automatically redacted in terminal output.
  Log files contain full header values — protect them accordingly.
`);
}

function parseArgs(argv) {
  const args   = argv.slice(2);
  const result = { command: null, positional: [] };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { result.help = true; continue; }
    if (a === '--version' || a === '-v') { result.version = true; continue; }

    if (!a.startsWith('--')) {
      if (!result.command) result.command = a;
      else result.positional.push(a);
      continue;
    }

    const key = a.slice(2);
    const next = args[i + 1];

    switch (key) {
      case 'port':           result.port          = parseInt(next, 10); i++; break;
      case 'target':         result.target        = next; i++; break;
      case 'log':            result.logFile       = next; i++; break;
      case 'filter':         result.filter        = next; i++; break;
      case 'inject-header':  result.injectHeader  = parseInjectHeader(next); i++; break;
      case 'inspect':        result.inspect       = true; break;
      case 'index':          result.index         = parseInt(next, 10); i++; break;
      default:
        process.stderr.write(`${C.yellow}Unknown flag:${C.reset} --${key}\n`);
    }
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.version) {
    process.stdout.write('1.0.0\n');
    process.exit(0);
  }

  if (!args.command || args.help || args.command === 'help') {
    printHelp();
    process.exit(0);
  }

  // ── start ──────────────────────────────────────────────────────────────────
  if (args.command === 'start') {
    const port   = args.port   ?? 8080;
    const target = args.target ?? 'http://localhost:3000';

    // Validate target URL
    let parsedTarget;
    try { parsedTarget = new URL(target); } catch {
      process.stderr.write(`${C.red}Error:${C.reset} invalid target URL: ${target}\n`);
      process.exit(1);
    }

    const { server, logger } = buildProxy({
      target,
      inspect:       args.inspect      ?? false,
      logFile:       args.logFile      ?? null,
      filter:        args.filter       ?? null,
      injectHeader:  args.injectHeader ?? null,
    });

    // Header banner
    process.stdout.write('\n');
    process.stdout.write(`${C.bold}${C.cyan}http-proxy-cli${C.reset}  v1.0.0\n`);
    process.stdout.write(`${C.gray}${'─'.repeat(60)}${C.reset}\n`);
    process.stdout.write(`  Listening   ${C.green}http://localhost:${port}${C.reset}\n`);
    process.stdout.write(`  Target      ${C.cyan}${target}${C.reset}\n`);
    if (args.inspect)      process.stdout.write(`  Inspect     ${C.yellow}on${C.reset}\n`);
    if (args.logFile)      process.stdout.write(`  Log file    ${C.yellow}${args.logFile}${C.reset}\n`);
    if (args.filter)       process.stdout.write(`  Filter      ${C.yellow}${args.filter}${C.reset}\n`);
    if (args.injectHeader) process.stdout.write(`  Inject      ${C.yellow}${args.injectHeader.name}: ${args.injectHeader.value}${C.reset}\n`);
    process.stdout.write(`${C.gray}${'─'.repeat(60)}${C.reset}\n`);
    process.stdout.write(`  ${C.dim}TIME          METHOD             STATUS  MS           SIZE         PATH${C.reset}\n`);
    process.stdout.write(`${C.gray}${'─'.repeat(60)}${C.reset}\n\n`);

    server.listen(port, '127.0.0.1', () => {
      // ready
    });

    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`${C.red}Error:${C.reset} port ${port} is already in use.\n`);
      } else {
        process.stderr.write(`${C.red}Server error:${C.reset} ${err.message}\n`);
      }
      process.exit(1);
    });

    const shutdown = () => {
      process.stdout.write(`\n${C.gray}Shutting down…${C.reset}\n`);
      server.close(() => {
        logger.close();
        process.exit(0);
      });
    };

    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  // ── replay ─────────────────────────────────────────────────────────────────
  if (args.command === 'replay') {
    const logFile = args.positional[0];
    if (!logFile) {
      process.stderr.write(`${C.red}Error:${C.reset} replay requires a log file path.\n`);
      process.stderr.write(`  Usage: http-proxy-cli replay <log-file> [--index 3]\n`);
      process.exit(1);
    }
    await replay(logFile, {
      target: args.target,
      index:  args.index != null ? args.index : null,
    });
    return;
  }

  process.stderr.write(`${C.red}Unknown command:${C.reset} ${args.command}\n`);
  printHelp();
  process.exit(1);
}

main().catch(err => {
  process.stderr.write(`${C.red}Fatal:${C.reset} ${err.message}\n`);
  process.exit(1);
});
