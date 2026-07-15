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
 *   GS_BIN       ghostscript binary, used to page-count uploaded PDF songs
 *                (default: "gs" on PATH)
 *   AUTH_CHECK_URL   instrumenta's "who is this" endpoint, called with the
 *                    incoming request's cookies/Authorization header to
 *                    resolve the logged-in username (default:
 *                    https://instrumenta.cc/api/auth.php?action=get_current_user)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');
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

// ---------------------------------------------------------------------------
// PDF song helpers — scanned sheet music, stored alongside lyric songs in
// SONGS_DIR but *with* a .pdf extension (lyric songs never have one).  The
// book (src/book.typ, via bin/parse-songs.py) embeds these directly as pages
// using Typst's native PDF-as-image support; this server only needs to let
// the manager UI list/upload/rename/delete them and preview the raw bytes.
// ---------------------------------------------------------------------------

function isPdfSongName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('..')) return false;
  if (name.startsWith('.')) return false;
  if (path.extname(name).toLowerCase() !== '.pdf') return false;
  if (path.basename(name, path.extname(name)) === '') return false;
  return true;
}

function pdfSongPath(name) {
  if (!isPdfSongName(name)) throw new HttpError(400, 'Invalid PDF name (must end in .pdf, no slashes)');
  const p = path.join(SONGS_DIR, name);
  if (path.dirname(p) !== SONGS_DIR) throw new HttpError(400, 'Invalid PDF name');
  return p;
}

const GS_BIN = process.env.GS_BIN || 'gs';

// Page count via Ghostscript — same trick bin/parse-songs.py uses at build
// time, kept here too so the manager UI can show it right after upload.
function pdfPageCount(filePath) {
  return new Promise((resolve) => {
    const ps = `(${filePath.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')}) (r) file runpdfbegin pdfpagecount = quit`;
    execFile(GS_BIN, ['-q', '-dNODISPLAY', `--permit-file-read=${filePath}`, '-c', ps],
      { timeout: 20000 }, (err, stdout) => {
        if (err) return resolve(null);
        const n = parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(n) && n > 0 ? n : null);
      });
  });
}

// Page counts are cached by (mtime, size) so re-listing the same unchanged
// PDF doesn't re-shell-out to Ghostscript — with a few dozen PDFs, doing that
// on every /api/pdfs call (which fires after nearly every unrelated edit) is
// the difference between an instant UI and a multi-second one.
const pdfPageCountCache = new Map(); // name -> { mtimeMs, size, pages }

async function cachedPdfPageCount(name, p, st) {
  const cached = pdfPageCountCache.get(name);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.pages;
  const pages = await pdfPageCount(p);
  pdfPageCountCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, pages });
  return pages;
}

async function listPdfSongs() {
  let names;
  try { names = await fsp.readdir(SONGS_DIR); } catch { return []; }
  const results = await Promise.all(names.filter(isPdfSongName).map(async (name) => {
    const p = path.join(SONGS_DIR, name);
    let st;
    try { st = await fsp.stat(p); } catch { return null; }
    if (!st.isFile()) return null;
    const title = titleFromName(path.basename(name, '.pdf'));
    const pages = await cachedPdfPageCount(name, p, st);
    return { name, title, kind: 'pdf', bytes: st.size, mtime: st.mtimeMs, pages };
  }));
  const out = results.filter(Boolean);
  out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return out;
}

// ---------------------------------------------------------------------------
// PDF page crops — a per-page crop rectangle (fractions 0..1 of page
// width/height) so a scanned page can be trimmed in the built songbook
// without touching the source PDF. Stored as a sidecar JSON file per PDF in
// SONGS_DIR/.crops/, named after the PDF (e.g. ".crops/Danny Boy.pdf.json").
// The leading dot keeps it invisible to isSongName/isPdfSongName's directory
// scans (both reject dotfiles), and bin/parse-songs.py mirrors this same
// layout at build time.
// ---------------------------------------------------------------------------

const CROPS_DIR = path.join(SONGS_DIR, '.crops');

function cropsPath(name) {
  if (!isPdfSongName(name)) throw new HttpError(400, 'Invalid PDF name');
  return path.join(CROPS_DIR, name + '.json');
}

async function readCrops(name) {
  try {
    const raw = await fsp.readFile(cropsPath(name), 'utf8');
    const data = JSON.parse(raw);
    return { pages: (data && typeof data.pages === 'object' && data.pages) || {} };
  } catch {
    return { pages: {} };
  }
}

async function writeCrops(name, data) {
  await fsp.mkdir(CROPS_DIR, { recursive: true });
  await fsp.writeFile(cropsPath(name), JSON.stringify(data, null, 2) + '\n');
}

function validCropRect(r) {
  if (!r || typeof r !== 'object') return false;
  const { left, top, right, bottom } = r;
  const nums = [left, top, right, bottom];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  const MIN_SPAN = 0.02;
  if (left < 0 || top < 0 || right > 1 || bottom > 1) return false;
  if (right - left < MIN_SPAN || bottom - top < MIN_SPAN) return false;
  return true;
}

// Rasterize one page to PNG — used both for the crop-mode preview in the
// manager UI and (at dpi=PAGE_SIZE_DPI) to measure the page's physical size.
// Not cached (unlike page counts) — only hit while a user has a PDF song
// open, not on every unrelated edit.
const CROP_PREVIEW_DPI = 120;

function renderPdfPagePng(filePath, page, dpi = CROP_PREVIEW_DPI) {
  return new Promise((resolve, reject) => {
    execFile(GS_BIN, [
      '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', `-r${dpi}`,
      `-dFirstPage=${page}`, `-dLastPage=${page}`, `--permit-file-read=${filePath}`,
      '-sOutputFile=%stdout%', filePath,
    ], { timeout: 30000, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new HttpError(500, 'Ghostscript page render failed (is `gs` installed?)'));
      if (!stdout || !stdout.length) return reject(new HttpError(500, 'Ghostscript produced no output'));
      resolve(stdout);
    });
  });
}

function pngDimensions(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// Page size in points, derived from the *same* rasterizer as the crop-mode
// preview (rendered at a DPI where pixels map 1:1 to points), not from
// Ghostscript's `bbox` device — bbox reports the ink content's bounding box
// (an auto-trim), which is usually smaller than the nominal page and would
// silently mismatch what the crop UI actually showed the user, throwing off
// every crop rectangle's scale in the Typst build. Assumes a uniform page
// size across the document (true for scanned books), so only page 1 is
// ever queried.
const PAGE_SIZE_DPI = 72; // 1 point == 1px at 72dpi, so pixel dims are points directly

async function pdfPageSize(filePath) {
  let png;
  try { png = await renderPdfPagePng(filePath, 1, PAGE_SIZE_DPI); } catch { return null; }
  const dims = pngDimensions(png);
  return dims && dims[0] > 0 && dims[1] > 0 ? dims : null;
}

const CHORD_RE = /\(([A-G](?:#{1,2}|b{1,2})?(?:maj|min|sus|aug|dim|add|m)?\d?(?:\/[A-G](?:#{1,2}|b{1,2})?)?)\)/g;

// A metadata directive line: "{author: Trad.}", "{history: ...}",
// "{flags: needs-chords}". The value may be empty ("{note: }") — new songs
// are stubbed out with every known metadata directive present but blank,
// ready to fill in.
const DIRECTIVE_RE = /^\s*\{\s*([a-zA-Z][\w-]*)\s*:\s*(.*?)\s*\}\s*$/;
// Parenthetical editorial markers stripped from a file name to make a title.
const EDITORIAL_RE = /\s*[\(\[][^)\]]*\b(needs?|add|find|confirm|check|decide|jonathan|chords?|cords|lyrics|notation|chorus|bridge|verse|tbd|wip)\b[^)\]]*[\)\]]/gi;
// "stub" was folded into "needs-lyrics" — a short/empty song is just a song
// that still needs lyrics, no separate concept needed.
const KNOWN_FLAGS = ['needs-lyrics', 'needs-chords', 'notation', 'ready'];
// Metadata directives a song can carry (matches book.typ's META-LABELS):
// author (regular directive, not a special leading line), history (a short
// prose blurb — "A war song of the Irish rebellion."), and note (free-form,
// e.g. "capo 2, to match D tin whistle"). Everything else (key/capo/tempo/
// tuning/source/trad) was folded into `note` as free text — the book never
// needs those as separate structured fields.
const META_KEYS = ['author', 'history', 'note'];
// Flags a freshly-created song starts with — nothing is inferred from
// content anymore, so new songs are explicitly marked incomplete until the
// author clears these themselves.
const DEFAULT_CREATE_FLAGS = ['needs-lyrics', 'needs-chords'];

// A new song's starting content: every known metadata directive stubbed out
// blank, plus the default workflow flags, so the editor shows the full set
// of fields to fill in rather than an empty file.
function defaultNewSongContent() {
  const lines = META_KEYS.map((k) => `{${k}: }`);
  lines.push(`{flags: ${DEFAULT_CREATE_FLAGS.join(', ')}}`);
  return lines.join('\n') + '\n';
}

// The title is always the (editorially-cleaned) file name.
function titleFromName(name) {
  const t = String(name).replace(EDITORIAL_RE, '').trim();
  return t || String(name).trim();
}

function parseFlags(value) {
  if (!value) return [];
  return String(value).split(/[,\s]+/).map((f) => f.trim().toLowerCase()).filter(Boolean);
}

// Song files carry no title line. Optional `{...}` directives (author,
// history, note, flags) lead the file; then the body. Returns the author
// (from the `{author: ...}` directive), the full meta dict and the body
// start index.
function extractHeader(lines) {
  let i = 0;
  const meta = {};
  while (i < lines.length) {
    if (lines[i].trim() === '') { i++; continue; }
    const m = lines[i].match(DIRECTIVE_RE);
    if (!m) break;
    meta[m[1].toLowerCase()] = m[2].trim();
    i++;
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  return { author: meta.author || '', meta, bodyStart: i };
}

function analyze(name, content) {
  const raw = content || '';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const bytes = Buffer.byteLength(raw, 'utf8');
  const hasChords = new RegExp(CHORD_RE.source).test(raw);
  const hdr = extractHeader(lines);
  const title = titleFromName(name);
  const author = hdr.author;

  // Flags are purely manual (the `{flags: ...}` directive) — nothing is
  // inferred from content anymore.
  const manual = parseFlags(hdr.meta.flags);
  const tags = manual.length ? manual : ['ready'];

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
// only). Drops an existing flags directive and inserts the new one alongside
// the other directives, just before the body.
function applyFlags(content, flags) {
  const clean = parseFlags(Array.isArray(flags) ? flags.join(' ') : flags)
    .filter((f) => f !== 'ready');
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  const hdr = extractHeader(lines);
  const body = lines.slice(hdr.bodyStart);
  // Preserve any non-flags directives (author/history/note), then set the
  // flags line.
  const directives = Object.entries(hdr.meta)
    .filter(([k]) => k !== 'flags')
    .map(([k, v]) => `{${k}: ${v}}`);
  if (clean.length) directives.push(`{flags: ${clean.join(', ')}}`);

  const out = [];
  if (directives.length) {
    out.push(...directives);
  }
  if (body.length) {
    if (out.length) out.push('');
    out.push(...body);
  }
  return out.join('\n');
}

// Cached by (mtime, size), same idea as pdfPageCountCache above — a song's
// analysis only needs recomputing once its file actually changes, so a
// full listSongs() after the first only re-reads files that changed since.
const songAnalyzeCache = new Map(); // name -> { mtimeMs, size, info }

async function listSongs() {
  const names = await fsp.readdir(SONGS_DIR);
  // Each song needs its own stat (and, on a cache miss, a full read to
  // derive tags/flags/chords), but nothing depends on another song's
  // result — run them concurrently instead of one disk round-trip at a time.
  const results = await Promise.all(names.filter(isSongName).map(async (name) => {
    const p = path.join(SONGS_DIR, name);
    let st;
    try { st = await fsp.stat(p); } catch { return null; }
    if (!st.isFile()) return null;
    const cached = songAnalyzeCache.get(name);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return { ...cached.info, mtime: st.mtimeMs };
    }
    let content = '';
    try { content = await fsp.readFile(p, 'utf8'); } catch {}
    const info = analyze(name, content);
    songAnalyzeCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, info });
    return { ...info, mtime: st.mtimeMs };
  }));
  const out = results.filter(Boolean);
  out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return out;
}

// ---------------------------------------------------------------------------
// Build flags — global on/off switches for optional book content, set from
// the manager UI and forwarded to bin/build.sh (as FLAG_* env vars, which it
// turns into Typst --input flags — see src/book.typ's want-* variables).
// Persisted to BUILD_DIR so they survive a server restart; BUILD_DIR itself
// is excluded from git deploys (see songbook-manager-app memory), so this
// file is never clobbered by a redeploy.
// ---------------------------------------------------------------------------

const BUILD_FLAGS_PATH = path.join(BUILD_DIR, 'build-flags.json');
const DEFAULT_BUILD_FLAGS = { diagrams: false, author: true, history: true, note: true, chords: true, pdfs: true };
const BUILD_FLAG_KEYS = Object.keys(DEFAULT_BUILD_FLAGS);

function loadBuildFlags() {
  try {
    const saved = JSON.parse(fs.readFileSync(BUILD_FLAGS_PATH, 'utf8'));
    return { ...DEFAULT_BUILD_FLAGS, ...saved };
  } catch {
    return { ...DEFAULT_BUILD_FLAGS };
  }
}

function saveBuildFlags(flags) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(BUILD_FLAGS_PATH, JSON.stringify(flags), 'utf8');
}

const buildFlags = loadBuildFlags();

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
    env: {
      ...process.env,
      BUILD_DIR,
      FLAG_DIAGRAMS: buildFlags.diagrams ? 'on' : 'off',
      FLAG_AUTHOR: buildFlags.author ? 'on' : 'off',
      FLAG_HISTORY: buildFlags.history ? 'on' : 'off',
      FLAG_NOTE: buildFlags.note ? 'on' : 'off',
      FLAG_CHORDS: buildFlags.chords ? 'on' : 'off',
      FLAG_PDFS: buildFlags.pdfs ? 'on' : 'off',
    },
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
// Auth — this app is reverse-proxied under instrumenta.cc (see STRUCTURE.md),
// so it shares the site's cookies with every other instrumenta tool. Rather
// than re-implement iauth.php's session/token resolution locally (session
// hydration from the session_token cookie involves rotation and a PHP-native
// $_SESSION this process has no access to), each request's credentials
// (Cookie, Authorization, ?apikey=) are forwarded as-is to instrumenta's own
// "who is this" endpoint and PHP is asked to resolve them — the exact same
// code path every other instrumenta tool relies on.
// ---------------------------------------------------------------------------

const AUTH_CHECK_URL = process.env.AUTH_CHECK_URL
  || 'https://instrumenta.cc/api/auth.php?action=get_current_user';
const AUTH_CACHE_TTL_MS = 15000; // avoid round-tripping to PHP on every asset/API request in one page load

const authCache = new Map(); // credentialsKey -> { user, expiresAt }

function authCredentialsKey(req, apikey) {
  return `${req.headers.cookie || ''}|${req.headers.authorization || ''}|${apikey || ''}`;
}

function checkAuth(req, url) {
  const apikey = url.searchParams.get('apikey');
  const key = authCredentialsKey(req, apikey);
  const cached = authCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.user);

  return new Promise((resolve) => {
    const target = new URL(AUTH_CHECK_URL);
    if (apikey) target.searchParams.set('apikey', apikey);
    const headers = {};
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    if (req.headers.authorization) headers.authorization = req.headers.authorization;

    const checkReq = https.request(target, { method: 'GET', headers, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let user = null;
        try {
          const data = JSON.parse(body);
          if (res.statusCode === 200 && data && data.username) user = data.username;
        } catch { /* not JSON, or an error payload — treat as unauthorized */ }
        authCache.set(key, { user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
        resolve(user);
      });
    });
    checkReq.on('error', () => resolve(null));
    checkReq.on('timeout', () => { checkReq.destroy(); resolve(null); });
    checkReq.end();
  });
}

// ---------------------------------------------------------------------------
// Edit history — a lightweight audit trail of who changed which song/PDF and
// when, shown in the manager UI next to the build status pill. Persisted to
// BUILD_DIR (same as build-flags.json) so it survives restarts/redeploys.
// ---------------------------------------------------------------------------

const EDIT_LOG_PATH = path.join(BUILD_DIR, 'edit-log.json');
const EDIT_LOG_MAX = 1000;

function loadEditLog() {
  try { return JSON.parse(fs.readFileSync(EDIT_LOG_PATH, 'utf8')); }
  catch { return []; }
}

const editLog = loadEditLog();

// `file` is a display string, not a raw filename — e.g. "Danny Boy" or
// "Danny Boy → Danny Boy (Irish)" for a rename — so the UI never has to
// re-derive titles from the log itself.
function recordEdit(user, action, file) {
  editLog.unshift({ user, action, file, at: Date.now() });
  if (editLog.length > EDIT_LOG_MAX) editLog.length = EDIT_LOG_MAX;
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(EDIT_LOG_PATH, JSON.stringify(editLog));
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
  return (await readRawBody(req, limit)).toString('utf8');
}

// Binary variant for PDF uploads — readBody's toString('utf8') would corrupt
// non-text bytes.
async function readRawBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

  // /api/edits — recent edit history (who changed what, when).
  if (seg[0] === 'edits') {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 200, EDIT_LOG_MAX);
    return sendJson(res, 200, { edits: editLog.slice(0, limit) });
  }

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
        // Songs carry no title line; a new song starts as a stub — every
        // known metadata directive blank plus the default workflow flags —
        // unless the caller explicitly supplies content.
        const content = typeof body.content === 'string' ? body.content : defaultNewSongContent();
        await fsp.writeFile(p, content, 'utf8');
        recordEdit(req.authorizedUser, 'create', titleFromName(name));
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
      recordEdit(req.authorizedUser, 'rename', `${titleFromName(name)} → ${titleFromName(to)}`);
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
      recordEdit(req.authorizedUser, 'flags', titleFromName(name));
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
        recordEdit(req.authorizedUser, 'edit', titleFromName(name));
        return sendJson(res, 200, {
          ...analyze(name, body.content),
          structure: parseStructure(name, body.content),
        });
      }
      if (method === 'DELETE') {
        if (!fs.existsSync(p)) throw new HttpError(404, 'Song not found');
        await fsp.unlink(p);
        recordEdit(req.authorizedUser, 'delete', titleFromName(name));
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }
  }

  // /api/pdfs ... — scanned sheet-music songs (see "PDF song helpers" above).
  if (seg[0] === 'pdfs') {
    if (seg.length === 1) {
      if (method === 'GET') return sendJson(res, 200, { pdfs: await listPdfSongs() });
      throw new HttpError(405, 'Method not allowed');
    }

    const name = decodeURIComponent(seg[1]);

    // /api/pdfs/:name/rename
    if (seg[2] === 'rename' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const to = (body.to || '').trim();
      if (!isPdfSongName(to)) throw new HttpError(400, 'Invalid target name (must end in .pdf)');
      const from = pdfSongPath(name);
      const dest = pdfSongPath(to);
      if (!fs.existsSync(from)) throw new HttpError(404, 'PDF not found');
      if (fs.existsSync(dest)) throw new HttpError(409, 'Target name already exists');
      await fsp.rename(from, dest);
      recordEdit(req.authorizedUser, 'rename',
        `${titleFromName(path.basename(name, '.pdf'))} → ${titleFromName(path.basename(to, '.pdf'))}`);
      const cached = pdfPageCountCache.get(name);
      pdfPageCountCache.delete(name);
      if (cached) pdfPageCountCache.set(to, cached);
      try { await fsp.rename(cropsPath(name), cropsPath(to)); } catch { /* no crop data to move */ }
      return sendJson(res, 200, { ok: true, name: to });
    }

    // /api/pdfs/:name/crop[/:page] — per-page crop rectangles (see "PDF page
    // crops" helpers above).
    if (seg[2] === 'crop') {
      if (seg.length === 3) {
        if (method === 'GET') return sendJson(res, 200, await readCrops(name));
        throw new HttpError(405, 'Method not allowed');
      }
      if (seg.length === 4) {
        const page = parseInt(seg[3], 10);
        if (!Number.isInteger(page) || page < 1) throw new HttpError(400, 'Invalid page number');
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}');
          if (!validCropRect(body)) throw new HttpError(400, 'Invalid crop rectangle');
          const rect = { left: body.left, top: body.top, right: body.right, bottom: body.bottom };
          const data = await readCrops(name);
          data.pages[String(page)] = rect;
          await writeCrops(name, data);
          return sendJson(res, 200, rect);
        }
        if (method === 'DELETE') {
          const data = await readCrops(name);
          delete data.pages[String(page)];
          await writeCrops(name, data);
          return sendJson(res, 200, { ok: true });
        }
        throw new HttpError(405, 'Method not allowed');
      }
    }

    // /api/pdfs/:name/page/:page.png — rasterized page preview for the
    // crop-mode drag overlay.
    if (seg[2] === 'page' && seg.length === 4 && method === 'GET') {
      const m = /^(\d+)\.png$/.exec(seg[3]);
      if (!m) throw new HttpError(400, 'Expected /page/:n.png');
      const p = pdfSongPath(name);
      if (!fs.existsSync(p)) throw new HttpError(404, 'PDF not found');
      const png = await renderPdfPagePng(p, parseInt(m[1], 10));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(png);
    }

    if (seg.length === 2) {
      const p = pdfSongPath(name);
      if (method === 'GET') {
        if (!fs.existsSync(p)) throw new HttpError(404, 'PDF not found');
        const stat = fs.statSync(p);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': stat.size,
          'Content-Disposition': `inline; filename="${name.replace(/"/g, '')}"`,
          'Cache-Control': 'no-store',
        });
        return fs.createReadStream(p).pipe(res);
      }
      if (method === 'PUT') {
        const buf = await readRawBody(req);
        if (buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
          throw new HttpError(400, 'Not a PDF file');
        }
        const isNew = !fs.existsSync(p);
        await fsp.writeFile(p, buf);
        const st = await fsp.stat(p);
        const pages = await pdfPageCount(p);
        pdfPageCountCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, pages });
        recordEdit(req.authorizedUser, isNew ? 'upload' : 'replace', titleFromName(path.basename(name, '.pdf')));
        return sendJson(res, isNew ? 201 : 200, {
          name, title: titleFromName(path.basename(name, path.extname(name))), kind: 'pdf',
          bytes: st.size, mtime: st.mtimeMs, pages,
        });
      }
      if (method === 'DELETE') {
        if (!fs.existsSync(p)) throw new HttpError(404, 'PDF not found');
        await fsp.unlink(p);
        recordEdit(req.authorizedUser, 'delete', titleFromName(path.basename(name, '.pdf')));
        pdfPageCountCache.delete(name);
        try { await fsp.unlink(cropsPath(name)); } catch { /* no crop data to remove */ }
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }
  }

  // /api/build ...
  if (seg[0] === 'build') {
    if (seg[1] === 'flags') {
      if (method === 'GET') return sendJson(res, 200, buildFlags);
      if (method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        for (const k of BUILD_FLAG_KEYS) if (k in body) buildFlags[k] = !!body[k];
        saveBuildFlags(buildFlags);
        return sendJson(res, 200, buildFlags);
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (seg.length === 1 && method === 'POST') { startBuild(); return sendJson(res, 202, buildStatus()); }
    if ((seg[1] === 'status' || seg.length === 1) && method === 'GET') return sendJson(res, 200, buildStatus());
    throw new HttpError(405, 'Method not allowed');
  }

  throw new HttpError(404, 'Unknown endpoint');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    const authorized_user = await checkAuth(req, url);
    if (!authorized_user) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Access denied.');
    }
    req.authorizedUser = authorized_user;
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
