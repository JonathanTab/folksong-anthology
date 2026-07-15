#!/usr/bin/env node
'use strict';

/*
 * Folksong Anthology — song manager & build server.
 *
 * Zero external dependencies (Node built-ins only) so it deploys as plain
 * files and runs under pm2 without an `npm install` step.
 *
 * Config via environment:
 *   PORT         listen port (default 3939)
 *   HOST         bind address (default 127.0.0.1 — meant to sit behind a proxy)
 *   SONGS_DIR    directory holding the song files (default: this file's dir)
 *   BUILD_SCRIPT path to build script (default: <root>/bin/build.sh)
 *   BUILD_DIR    build output dir (default: <root>/build)
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || '3939', 10);
const HOST = process.env.HOST || '127.0.0.1';
const SONGS_DIR = path.resolve(process.env.SONGS_DIR || ROOT);
const PUBLIC_DIR = path.join(ROOT, 'public');
const BUILD_DIR = path.resolve(process.env.BUILD_DIR || path.join(ROOT, 'build'));
const BUILD_SCRIPT = path.resolve(process.env.BUILD_SCRIPT || path.join(ROOT, 'bin', 'build.sh'));
const PDF_PATH = path.join(BUILD_DIR, 'songbook.pdf');
const LOG_PATH = path.join(BUILD_DIR, 'build.log');

// Files that live in SONGS_DIR but are NOT songs (songs have no extension).
const RESERVED = new Set([
  'LICENSE', 'Makefile', 'Dockerfile', 'Procfile', 'server', 'CHANGELOG',
]);

// ---------------------------------------------------------------------------
// Song file helpers
// ---------------------------------------------------------------------------

// A song file is a plain file in SONGS_DIR with no extension, not a dotfile,
// and not on the reserved list. This matches bin/parse-songs.py's own filter.
function isSongName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('..')) return false;
  if (name.startsWith('.')) return false;
  if (path.extname(name) !== '') return false;
  if (RESERVED.has(name)) return false;
  return true;
}

function songPath(name) {
  if (!isSongName(name)) throw new HttpError(400, 'Invalid song name');
  const p = path.join(SONGS_DIR, name);
  // Defense in depth: ensure it stays inside SONGS_DIR.
  if (path.dirname(p) !== SONGS_DIR) throw new HttpError(400, 'Invalid song name');
  return p;
}

const CHORD_RE = /\(([A-G](?:#{1,2}|b{1,2})?(?:maj|min|sus|aug|dim|add|m)?\d?(?:\/[A-G](?:#{1,2}|b{1,2})?)?)\)/g;

// A metadata directive line: "{key: G}", "{capo: 2}", "{flags: needs-chords}".
const DIRECTIVE_RE = /^\s*\{\s*([a-zA-Z][\w-]*)\s*:\s*(.+?)\s*\}\s*$/;
// Whole-line section cue / inline marker (so they aren't mistaken for authors).
const CUE_RE = /^\s*[\(\[]\s*(chorus|bridge)([^)\]]*)[\)\]]\s*[.,]?\s*$/i;
const MARK_RE = /^\s*[\(\[]\s*(chorus|bridge)\s*[\)\]]\s*[:-]?\s*/i;
// Parenthetical editorial markers stripped from a file name to make a title.
const EDITORIAL_RE = /\s*[\(\[][^)\]]*\b(needs?|add|find|confirm|check|decide|jonathan|chords?|cords|lyrics|notation|chorus|bridge|verse|tbd|wip)\b[^)\]]*[\)\]]/gi;
const BOILERPLATE = 'Enter text in [Markdown]';
const KNOWN_FLAGS = ['needs-lyrics', 'needs-chords', 'notation', 'stub', 'ready'];

// The title is always the (editorially-cleaned) file name.
function titleFromName(name) {
  const t = String(name).replace(EDITORIAL_RE, '').trim();
  return t || String(name).trim();
}

function looksLikeLyric(line) {
  if (new RegExp(CHORD_RE.source).test(line)) return true;
  const s = line.trim();
  if (s.length > 45) return true;
  if (s.length > 25 && /[,;:]$/.test(s)) return true;
  if (s.includes(',') && s.length > 32) return true;
  return false;
}

function parseFlags(value) {
  if (!value) return [];
  return String(value).split(/[,\s]+/).map((f) => f.trim().toLowerCase()).filter(Boolean);
}

// Song files carry no title line.  An optional author line may lead the file
// (short, non-lyric, followed by a blank line); then optional `{...}`
// directives; then the body.  Returns author, meta and the body start index.
function extractHeader(lines) {
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  let author = '';
  if (i < lines.length && lines[i].trim() !== ''
      && !DIRECTIVE_RE.test(lines[i])
      && !looksLikeLyric(lines[i])
      && !CUE_RE.test(lines[i]) && !MARK_RE.test(lines[i])
      && lines[i].trim().length <= 40
      && (i + 1 >= lines.length || lines[i + 1].trim() === '')) {
    author = lines[i].trim(); i++;
  }
  const meta = {};
  while (i < lines.length) {
    if (lines[i].trim() === '') { i++; continue; }
    const m = lines[i].match(DIRECTIVE_RE);
    if (!m) break;
    meta[m[1].toLowerCase()] = m[2].trim();
    i++;
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  return { author, meta, bodyStart: i };
}

// Flags implied purely by content (no file-name heuristics).
function inferFlags(raw, hasChords) {
  const t = (raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const bodyLines = t.split('\n').filter((l) => l.trim() && !DIRECTIVE_RE.test(l));
  const flags = new Set();
  if (t.trim().length <= 1 || bodyLines.length === 0 || t.includes(BOILERPLATE)) {
    flags.add('needs-lyrics');
    return flags;
  }
  if (bodyLines.length < 6) flags.add('stub');
  if (!hasChords) flags.add('needs-chords');
  return flags;
}

function analyze(name, content) {
  const raw = content || '';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const bytes = Buffer.byteLength(raw, 'utf8');
  const hasChords = new RegExp(CHORD_RE.source).test(raw);
  const hdr = extractHeader(lines);
  const title = titleFromName(name);
  const author = hdr.author;

  const inferred = inferFlags(raw, hasChords);
  const manual = parseFlags(hdr.meta.flags);
  const tags = Array.from(new Set([...inferred, ...manual]));
  if (tags.length === 0) tags.push('ready');

  return {
    name,
    title,
    author,
    bytes,
    lines: lines.length,
    hasChords,
    flags: manual,
    tags,
  };
}

// Parse into a structure the UI can render as a preview.
function parseStructure(name, content) {
  const text = (content || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const { author, bodyStart } = extractHeader(lines);
  const body = lines.slice(bodyStart).join('\n');
  const blocks = [];
  for (const chunk of body.split(/\n\s*\n/)) {
    const bl = chunk.split('\n').filter((l) => l.length > 0);
    if (bl.length === 0) continue;
    const isChorus = /^\s*[\(\[]\s*chorus/i.test(bl[0]);
    blocks.push({ type: isChorus ? 'chorus' : 'verse', lines: bl });
  }
  return { title: titleFromName(name), author, blocks };
}

// Rewrite a song's `{flags: ...}` directive to exactly `flags` (manual flags
// only).  Keeps a leading author line, drops an existing flags directive, and
// inserts the new one just before the body.
function applyFlags(content, flags) {
  const clean = parseFlags(Array.isArray(flags) ? flags.join(' ') : flags)
    .filter((f) => f !== 'ready');
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  const hdr = extractHeader(lines);
  const body = lines.slice(hdr.bodyStart);
  // Preserve any non-flags directives (key/capo/…), then set the flags line.
  const directives = Object.entries(hdr.meta)
    .filter(([k]) => k !== 'flags')
    .map(([k, v]) => `{${k}: ${v}}`);
  if (clean.length) directives.push(`{flags: ${clean.join(', ')}}`);

  const out = [];
  if (hdr.author) out.push(hdr.author);
  if (directives.length) {
    if (out.length) out.push('');
    out.push(...directives);
  }
  if (body.length) {
    if (out.length) out.push('');
    out.push(...body);
  }
  return out.join('\n');
}

async function listSongs() {
  const names = await fsp.readdir(SONGS_DIR);
  const out = [];
  for (const name of names) {
    if (!isSongName(name)) continue;
    let st;
    try { st = await fsp.stat(path.join(SONGS_DIR, name)); } catch { continue; }
    if (!st.isFile()) continue;
    let content = '';
    try { content = await fsp.readFile(path.join(SONGS_DIR, name), 'utf8'); } catch {}
    const info = analyze(name, content);
    out.push({ ...info, mtime: st.mtimeMs });
  }
  out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return out;
}

// ---------------------------------------------------------------------------
// Build state machine
// ---------------------------------------------------------------------------

const build = {
  state: 'idle',      // idle | running | success | failed
  id: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  child: null,
  log: '',
};

function startBuild() {
  if (build.state === 'running') return build;
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  build.state = 'running';
  build.id = randomUUID();
  build.startedAt = Date.now();
  build.finishedAt = null;
  build.exitCode = null;
  build.log = '';

  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
  const header = `▶ Build ${build.id} started ${new Date().toISOString()}\n`;
  build.log += header; logStream.write(header);

  const child = spawn('bash', [BUILD_SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, BUILD_DIR },
  });
  build.child = child;

  const append = (buf) => {
    const s = buf.toString();
    build.log += s;
    if (build.log.length > 500000) build.log = build.log.slice(-500000);
    logStream.write(s);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  child.on('close', (code) => {
    build.exitCode = code;
    build.finishedAt = Date.now();
    const havePdf = fs.existsSync(PDF_PATH);
    build.state = code === 0 && havePdf ? 'success' : 'failed';
    const footer = `\n▶ Build finished exit=${code} pdf=${havePdf} state=${build.state}\n`;
    build.log += footer; logStream.end(footer);
    build.child = null;
  });
  child.on('error', (err) => {
    build.log += `\n❌ Failed to launch build: ${err.message}\n`;
    build.state = 'failed';
    build.finishedAt = Date.now();
    build.child = null;
    try { logStream.end(); } catch {}
  });

  return build;
}

function buildStatus() {
  return {
    state: build.state,
    id: build.id,
    startedAt: build.startedAt,
    finishedAt: build.finishedAt,
    exitCode: build.exitCode,
    log: build.log,
    hasPdf: fs.existsSync(PDF_PATH),
    pdfMtime: fs.existsSync(PDF_PATH) ? fs.statSync(PDF_PATH).mtimeMs : null,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const p = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!p.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Forbidden');
  let data;
  try { data = await fsp.readFile(p); } catch { throw new HttpError(404, 'Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  res.end(data);
}

function servePdf(res) {
  if (!fs.existsSync(PDF_PATH)) throw new HttpError(404, 'No songbook has been built yet');
  const stat = fs.statSync(PDF_PATH);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': stat.size,
    'Content-Disposition': 'inline; filename="songbook.pdf"',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(PDF_PATH).pipe(res);
}

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','songs','Foo']
  const seg = parts.slice(1); // drop 'api'
  const method = req.method;

  // /api/health
  if (seg[0] === 'health') return sendJson(res, 200, { ok: true, songsDir: SONGS_DIR });

  // /api/songs ...
  if (seg[0] === 'songs') {
    if (seg.length === 1) {
      if (method === 'GET') return sendJson(res, 200, { songs: await listSongs() });
      if (method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = (body.name || '').trim();
        if (!isSongName(name)) throw new HttpError(400, 'Invalid song name (no extension, no slashes)');
        const p = songPath(name);
        if (fs.existsSync(p)) throw new HttpError(409, 'A song with that name already exists');
        // Songs carry no title line; a new song starts as an empty body.
        const content = typeof body.content === 'string' ? body.content : '';
        await fsp.writeFile(p, content, 'utf8');
        return sendJson(res, 201, { ...analyze(name, content) });
      }
      throw new HttpError(405, 'Method not allowed');
    }

    const name = decodeURIComponent(seg[1]);
    // /api/songs/:name/rename
    if (seg[2] === 'rename' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const to = (body.to || '').trim();
      if (!isSongName(to)) throw new HttpError(400, 'Invalid target name');
      const from = songPath(name);
      const dest = songPath(to);
      if (!fs.existsSync(from)) throw new HttpError(404, 'Song not found');
      if (fs.existsSync(dest)) throw new HttpError(409, 'Target name already exists');
      await fsp.rename(from, dest);
      return sendJson(res, 200, { ok: true, name: to });
    }

    // /api/songs/:name/flags — set the manual `{flags: ...}` directive.
    if (seg[2] === 'flags' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const p = songPath(name);
      let content;
      try { content = await fsp.readFile(p, 'utf8'); }
      catch { throw new HttpError(404, 'Song not found'); }
      const updated = applyFlags(content, body.flags);
      await fsp.writeFile(p, updated, 'utf8');
      return sendJson(res, 200, {
        ...analyze(name, updated),
        content: updated,
        structure: parseStructure(name, updated),
      });
    }

    if (seg.length === 2) {
      const p = songPath(name);
      if (method === 'GET') {
        let content;
        try { content = await fsp.readFile(p, 'utf8'); }
        catch { throw new HttpError(404, 'Song not found'); }
        return sendJson(res, 200, {
          ...analyze(name, content),
          content,
          structure: parseStructure(name, content),
        });
      }
      if (method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.content !== 'string') throw new HttpError(400, 'content required');
        await fsp.writeFile(p, body.content, 'utf8');
        return sendJson(res, 200, {
          ...analyze(name, body.content),
          structure: parseStructure(name, body.content),
        });
      }
      if (method === 'DELETE') {
        if (!fs.existsSync(p)) throw new HttpError(404, 'Song not found');
        await fsp.unlink(p);
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }
  }

  // /api/build ...
  if (seg[0] === 'build') {
    if (seg.length === 1 && method === 'POST') { startBuild(); return sendJson(res, 202, buildStatus()); }
    if ((seg[1] === 'status' || seg.length === 1) && method === 'GET') return sendJson(res, 200, buildStatus());
    throw new HttpError(405, 'Method not allowed');
  }

  throw new HttpError(404, 'Unknown endpoint');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/pdf' || url.pathname === '/api/pdf') return servePdf(res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Folksong Anthology manager listening on http://${HOST}:${PORT}`);
  console.log(`  songs dir: ${SONGS_DIR}`);
  console.log(`  build dir: ${BUILD_DIR}`);
});
