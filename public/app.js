'use strict';

const $ = (id) => document.getElementById(id);
const api = {
  async req(method, path, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch('api/' + path, opt);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((data && data.error) || r.statusText);
    return data;
  },
  list: () => api.req('GET', 'songs'),
  read: (n) => api.req('GET', 'songs/' + encodeURIComponent(n)),
  save: (n, content) => api.req('PUT', 'songs/' + encodeURIComponent(n), { content }),
  // No content: the server stubs out a new song with every metadata
  // directive blank plus the default workflow flags.
  create: (name) => api.req('POST', 'songs', { name }),
  remove: (n) => api.req('DELETE', 'songs/' + encodeURIComponent(n)),
  rename: (n, to) => api.req('POST', 'songs/' + encodeURIComponent(n) + '/rename', { to }),
  setFlags: (n, flags) => api.req('POST', 'songs/' + encodeURIComponent(n) + '/flags', { flags }),
  build: () => api.req('POST', 'build'),
  buildStatus: () => api.req('GET', 'build/status'),
  getBuildFlags: () => api.req('GET', 'build/flags'),
  setBuildFlags: (flags) => api.req('POST', 'build/flags', flags),
  edits: (limit) => api.req('GET', 'edits' + (limit ? ('?limit=' + limit) : '')),
  listPdfs: () => api.req('GET', 'pdfs'),
  deletePdf: (n) => api.req('DELETE', 'pdfs/' + encodeURIComponent(n)),
  renamePdf: (n, to) => api.req('POST', 'pdfs/' + encodeURIComponent(n) + '/rename', { to }),
  getCrop: (n) => api.req('GET', 'pdfs/' + encodeURIComponent(n) + '/crop'),
  setCrop: (n, page, rect) => api.req('PUT', 'pdfs/' + encodeURIComponent(n) + '/crop/' + page, rect),
  deleteCrop: (n, page) => api.req('DELETE', 'pdfs/' + encodeURIComponent(n) + '/crop/' + page),
  cropPageImageUrl: (n, page) => 'api/pdfs/' + encodeURIComponent(n) + '/page/' + page + '.png?t=' + Date.now(),
  // Raw upload: the body is the File itself (fetch sends it as-is), not JSON.
  async uploadPdf(name, file) {
    const r = await fetch('api/pdfs/' + encodeURIComponent(name), { method: 'PUT', body: file });
    const data = await r.json();
    if (!r.ok) throw new Error((data && data.error) || r.statusText);
    return data;
  },
};

// Editorial markers stripped from a filename to make a display title.
const EDITORIAL_RE = /\s*[\(\[][^)\]]*\b(needs?|add|find|confirm|check|decide|jonathan|chords?|cords|lyrics|notation|chorus|bridge|verse|tbd|wip)\b[^)\]]*[\)\]]/gi;
const DIRECTIVE_RE = /^\s*\{\s*([a-zA-Z][\w-]*)\s*:\s*(.*?)\s*\}\s*$/;
const titleFromName = (name) => String(name || '').replace(EDITORIAL_RE, '').trim() || String(name || '').trim();

const state = {
  songs: [],
  pdfs: [],
  current: null,      // song name (lyric songs)
  currentKind: 'lyric', // 'lyric' | 'pdf' — which viewer is open
  currentPdf: null,   // pdf name (sheet-music songs)
  currentFlags: [],   // manual flags on the open song
  dirty: false,
  filter: 'all',
  query: '',
  savedContent: '',
  cropEditing: false, // whether the draggable crop rectangle + edit buttons are shown
  cropPages: {},      // loaded crop map for the open PDF: { "1": {left,top,right,bottom}, ... }
  cropPage: 1,        // page currently shown in the crop panel
  cropRect: null,     // in-progress rect for cropPage: {left,top,right,bottom} fractions
};

// ---- persisted UI state ----------------------------------------------------
// Remembers what was open plus the search/filter so returning after closing
// the browser (or a reload) drops you back where you left off. Only small
// UI state lives here — song content itself is always the server's copy.
const PERSIST_KEY = 'songbook.uiState';
function savePersistedState() {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      currentKind: state.currentKind,
      current: state.current,
      currentPdf: state.currentPdf,
      filter: state.filter,
      query: state.query,
    }));
  } catch (e) { /* storage unavailable/full — losing the last-open state is harmless */ }
}
function loadPersistedState() {
  try {
    return JSON.parse(localStorage.getItem(PERSIST_KEY)) || {};
  } catch (e) { return {}; }
}

// ---- toast ----------------------------------------------------------------
let toastTimer;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ---- modal (in-app replacement for window.confirm/prompt) -----------------
// Resolves with the chosen action's `value`, or null if dismissed (Escape / backdrop / Cancel).
function showModal({ title, message, actions }) {
  return new Promise((resolve) => {
    const backdrop = $('modalBackdrop');
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      backdrop.hidden = true;
      document.removeEventListener('keydown', onKey);
      backdrop.removeEventListener('click', onBackdrop);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); settle(null); } };
    const onBackdrop = (e) => { if (e.target === backdrop) settle(null); };

    $('modalTitle').textContent = title;
    $('modalMessage').textContent = message;
    const actionsEl = $('modalActions');
    actionsEl.innerHTML = '';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-small ' + (a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost');
      btn.textContent = a.label;
      btn.onclick = () => settle(a.value);
      actionsEl.appendChild(btn);
    }
    backdrop.hidden = false;
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', onBackdrop);
    actionsEl.firstChild && actionsEl.firstChild.focus();
  });
}

// ---- song list --------------------------------------------------------
// Lyric songs and PDF (sheet-music) songs are merged into one alphabetical
// list, mirroring how they're interleaved in the compiled book.
function matchesFilter(s) {
  if (state.filter === 'all') return true;
  if (s.kind === 'pdf') return false; // workflow tags don't apply to PDFs
  return s.tags.includes(state.filter);
}
function renderList() {
  // Re-rendering rebuilds every <li>, which would otherwise drop keyboard
  // focus on every open/save/etc. Only restore it if focus was already
  // inside the list (i.e. the user is arrow-keying through it) — a save
  // triggered from the editor textarea shouldn't yank focus into the sidebar.
  const hadListFocus = !!document.activeElement?.closest?.('#songList');
  // Rebuilding via innerHTML also resets scrollTop to 0, which otherwise
  // yanks the sidebar back to the top on every save/flag-toggle/search
  // keystroke. Restore whatever position the user had scrolled to.
  const prevScrollTop = $('songList').scrollTop;
  const q = state.query.toLowerCase();
  const combined = [...state.songs, ...state.pdfs]
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const items = combined.filter((s) =>
    matchesFilter(s) && (!q || s.title.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)));
  $('count').textContent = `${items.length} of ${combined.length} songs`;
  const ul = $('songList');
  ul.innerHTML = '';
  for (const s of items) {
    const li = document.createElement('li');
    const isActive = s.kind === 'pdf'
      ? (state.currentKind === 'pdf' && s.name === state.currentPdf)
      : (state.currentKind === 'lyric' && s.name === state.current);
    li.className = 'song-item' + (isActive ? ' is-active' : '');
    li.tabIndex = 0;
    if (s.kind === 'pdf') {
      li.innerHTML = `
        <span class="name">${esc(s.title || s.name)}</span>
        <span class="meta">
          <span class="dot pdf">●</span>PDF
          ${s.pages ? `<span>· ${s.pages} page${s.pages === 1 ? '' : 's'}</span>` : ''}
        </span>`;
      li.onclick = () => openPdf(s.name);
    } else {
      const tag = s.tags[0] || 'ready';
      li.innerHTML = `
        <span class="name">${esc(s.title || s.name)}</span>
        <span class="meta">
          <span class="dot ${tag}">●</span>${esc(s.tags.join(', '))}
          <span>· ${s.lines} lines</span>
          ${s.hasChords ? '<span>· chords</span>' : ''}
        </span>`;
      li.onclick = () => openSong(s.name);
    }
    ul.appendChild(li);
  }
  if (hadListFocus) ul.querySelector('.song-item.is-active')?.focus();
  ul.scrollTop = prevScrollTop;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

// Arrow-key scrubbing: Up/Down moves focus to the adjacent sidebar item and
// opens it, so you can hold/tap arrows to step through songs one by one.
$('songList').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const li = e.target.closest('.song-item');
  if (!li) return;
  e.preventDefault();
  const items = Array.from($('songList').children);
  const next = items[items.indexOf(li) + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
  next.click();
});

async function refresh() {
  const [{ songs }, { pdfs }] = await Promise.all([api.list(), api.listPdfs()]);
  state.songs = songs;
  state.pdfs = pdfs;
  renderList();
}

// Local state patches used instead of refresh() after a single-song edit —
// every mutating action's response already tells us everything that
// changed, so there's no need to re-fetch (and, for songs, re-read every
// file; for PDFs, re-run Ghostscript on every one) just to reflect it.
function upsertSong(name, fields) {
  const idx = state.songs.findIndex((s) => s.name === name);
  if (idx === -1) state.songs.push({ name, ...fields });
  else state.songs[idx] = { ...state.songs[idx], ...fields };
}
function removeSong(name) {
  state.songs = state.songs.filter((s) => s.name !== name);
}
function upsertPdf(name, fields) {
  const idx = state.pdfs.findIndex((p) => p.name === name);
  if (idx === -1) state.pdfs.push({ name, ...fields });
  else state.pdfs[idx] = { ...state.pdfs[idx], ...fields };
}
function removePdf(name) {
  state.pdfs = state.pdfs.filter((p) => p.name !== name);
}

// ---- editor ---------------------------------------------------------------
async function openSong(name) {
  if (state.dirty) {
    const choice = await showModal({
      title: 'Unsaved changes',
      message: `"${titleFromName(state.current)}" has unsaved changes. Save before switching?`,
      actions: [
        { label: 'Save', value: 'save', kind: 'primary' },
        { label: 'Discard', value: 'discard', kind: 'danger' },
        { label: 'Cancel', value: null, kind: 'ghost' },
      ],
    });
    if (choice === null) return;
    if (choice === 'save') {
      await save();
      if (state.dirty) return; // save failed; stay put
    }
  }
  $('songTitleInput').hidden = true;
  $('songTitle').hidden = false;
  const s = await api.read(name);
  state.current = name;
  state.currentKind = 'lyric';
  state.savedContent = s.content;
  state.dirty = false;
  $('emptyState').hidden = true;
  $('pdfViewer').hidden = true;
  $('editor').hidden = false;
  $('source').value = s.content;
  setDirty(false);
  renderMeta(s);
  renderPreview(s.structure);
  renderList();
  savePersistedState();
}

function renderMeta(s) {
  $('songTitle').textContent = s.title || titleFromName(s.name);
  $('songAuthor').textContent = s.author || '';
  $('badges').innerHTML = (s.tags || []).map((t) => `<span class="badge ${t}">${t}</span>`).join('') +
    `<span class="badge">${s.bytes} B</span>`;
  state.currentFlags = s.flags || [];
  renderFlagEditor();
}

// ---- PDF (sheet music) viewer ----------------------------------------------
async function openPdf(name) {
  if (state.dirty) {
    const choice = await showModal({
      title: 'Unsaved changes',
      message: `"${titleFromName(state.current)}" has unsaved changes. Save before switching?`,
      actions: [
        { label: 'Save', value: 'save', kind: 'primary' },
        { label: 'Discard', value: 'discard', kind: 'danger' },
        { label: 'Cancel', value: null, kind: 'ghost' },
      ],
    });
    if (choice === null) return;
    if (choice === 'save') {
      await save();
      if (state.dirty) return;
    } else {
      // Discarding: the lyric editor is about to be hidden, so there's no
      // save() call to clear dirty/the pending autosave — do it here, or
      // the debounced autosave would silently write the discarded edit
      // back a couple seconds later.
      setDirty(false);
    }
  }
  $('pdfTitleInput').hidden = true;
  $('pdfTitle').hidden = false;
  state.currentKind = 'pdf';
  state.currentPdf = name;
  $('emptyState').hidden = true;
  $('editor').hidden = true;
  $('pdfViewer').hidden = false;
  const p = state.pdfs.find((x) => x.name === name) || { name, title: titleFromName(name.replace(/\.pdf$/i, '')) };
  renderPdfMeta(p);
  showPdfPages(name);
  renderList();
  savePersistedState();
}

function renderPdfMeta(p) {
  $('pdfTitle').textContent = p.title || titleFromName(p.name.replace(/\.pdf$/i, ''));
  $('pdfBadges').innerHTML = '<span class="badge pdf">PDF</span>' +
    (p.pages ? `<span class="badge">${p.pages} page${p.pages === 1 ? '' : 's'}</span>` : '') +
    (p.bytes != null ? `<span class="badge">${Math.round(p.bytes / 1024)} KB</span>` : '');
}

function startPdfRenameEdit() {
  if (state.currentKind !== 'pdf' || !state.currentPdf) return;
  const input = $('pdfTitleInput');
  input.value = state.currentPdf;
  $('pdfTitle').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}
function cancelPdfRenameEdit() {
  $('pdfTitleInput').hidden = true;
  $('pdfTitle').hidden = false;
}
async function commitPdfRenameEdit() {
  const input = $('pdfTitleInput');
  if (input.hidden) return; // already committed/cancelled
  let to = input.value.trim();
  if (!to) { cancelPdfRenameEdit(); return; }
  if (!/\.pdf$/i.test(to)) to += '.pdf';
  if (to === state.currentPdf) { cancelPdfRenameEdit(); return; }
  try {
    await api.renamePdf(state.currentPdf, to);
    const prev = state.pdfs.find((p) => p.name === state.currentPdf);
    removePdf(state.currentPdf);
    upsertPdf(to, { ...prev, name: to, title: titleFromName(to.replace(/\.pdf$/i, '')) });
    cancelPdfRenameEdit();
    openPdf(to);
    toast('Renamed');
    refreshHistory();
  } catch (e) { toast(e.message, true); cancelPdfRenameEdit(); }
}
$('pdfRenameBtn').onclick = startPdfRenameEdit;
$('pdfTitle').addEventListener('click', startPdfRenameEdit);
$('pdfTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); startPdfRenameEdit(); }
});
$('pdfTitleInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitPdfRenameEdit(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelPdfRenameEdit(); }
});
$('pdfTitleInput').addEventListener('blur', commitPdfRenameEdit);

$('pdfDeleteBtn').onclick = async () => {
  if (!state.currentPdf) return;
  const choice = await showModal({
    title: 'Delete PDF',
    message: `Delete "${titleFromName(state.currentPdf.replace(/\.pdf$/i, ''))}"? This cannot be undone.`,
    actions: [
      { label: 'Delete', value: 'delete', kind: 'danger' },
      { label: 'Cancel', value: null, kind: 'ghost' },
    ],
  });
  if (choice !== 'delete') return;
  try {
    await api.deletePdf(state.currentPdf);
    removePdf(state.currentPdf);
    state.currentPdf = null;
    setCropEditing(false);
    $('pdfViewer').hidden = true; $('emptyState').hidden = false;
    renderList();
    savePersistedState();
    toast('Deleted');
    refreshHistory();
  } catch (e) { toast(e.message, true); }
};

// Upload: a fresh PDF via "+ PDF", or an in-place replacement via "Replace
// file" on an already-open PDF (pendingUploadName pins the target name so a
// same-named file doesn't trigger the "already exists" confirmation).
let pendingUploadName = null;
$('uploadPdfBtn').onclick = () => { pendingUploadName = null; $('pdfFileInput').click(); };
$('pdfReplaceBtn').onclick = () => {
  if (!state.currentPdf) return;
  pendingUploadName = state.currentPdf;
  $('pdfFileInput').click();
};
$('pdfFileInput').addEventListener('change', async () => {
  const file = $('pdfFileInput').files[0];
  const targetName = pendingUploadName;
  $('pdfFileInput').value = '';
  pendingUploadName = null;
  if (!file) return;
  let name = targetName || file.name;
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  if (!targetName && state.pdfs.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    const choice = await showModal({
      title: 'Replace existing PDF?',
      message: `A PDF named "${name}" already exists. Replace it?`,
      actions: [
        { label: 'Replace', value: 'replace', kind: 'danger' },
        { label: 'Cancel', value: null, kind: 'ghost' },
      ],
    });
    if (choice !== 'replace') return;
  }
  try {
    const info = await api.uploadPdf(name, file);
    upsertPdf(name, info);
    openPdf(name);
    toast('Uploaded');
    refreshHistory();
  } catch (e) { toast(e.message, true); }
});

// ---- PDF page viewer + crop mode ---------------------------------------
// A PDF song is always shown page-by-page as a rasterized preview (rather
// than the native browser PDF viewer) so the crop rectangle can be drawn
// directly over it in the same coordinate space it's saved in. "Crop pages"
// only toggles whether the draggable rectangle + its editing buttons are
// shown — page browsing (Prev/Next) works either way. A rectangle
// (fractions 0..1 of the page) is dragged/resized over the preview and
// auto-saved via api.setCrop on drag end; src/book.typ's pdf-page-image()
// applies it at build time. The full-image default
// {left:0,top:0,right:1,bottom:1} always represents "no crop" — pages with
// no saved entry render unchanged.
const CROP_MIN_SPAN = 0.02; // keep in sync with server.js's validCropRect
const FULL_CROP = { left: 0, top: 0, right: 1, bottom: 1 };

function currentPdfInfo() {
  return state.pdfs.find((p) => p.name === state.currentPdf) || null;
}

function setCropEditing(on) {
  state.cropEditing = on;
  $('pdfCropToggleBtn').classList.toggle('is-on', on);
  $('cropRect').hidden = !on;
  $('cropResetBtn').hidden = !on;
  $('cropApplyAllBtn').hidden = !on;
  $('cropReadout').hidden = !on;
}

async function showPdfPages(name) {
  setCropEditing(false);
  try {
    const data = await api.getCrop(name);
    state.cropPages = data.pages || {};
  } catch (e) {
    toast(e.message, true);
    state.cropPages = {};
  }
  loadCropPage(1);
}

function loadCropPage(page) {
  const info = currentPdfInfo();
  const total = (info && info.pages) || 1;
  page = Math.min(Math.max(1, page), total);
  state.cropPage = page;
  // Reflect the page change immediately — Prev/Next disabled + a spinner
  // over the (dimmed, still-stale) current image — since rasterizing the
  // next page on the server can take a moment.
  $('cropPageLabel').textContent = `Page ${page} / ${total}`;
  $('cropPrevBtn').disabled = true;
  $('cropNextBtn').disabled = true;
  state.cropRect = { ...(state.cropPages[String(page)] || FULL_CROP) };
  renderCropRectUI();
  const img = $('cropImg');
  const stage = $('cropStage');
  stage.classList.remove('crop-stage-error');
  stage.classList.add('crop-stage-loading');
  img.hidden = false;
  $('cropRect').hidden = !state.cropEditing;
  const finishLoad = () => {
    stage.classList.remove('crop-stage-loading');
    $('cropPrevBtn').disabled = page <= 1;
    $('cropNextBtn').disabled = page >= total;
  };
  img.onload = finishLoad;
  img.onerror = () => {
    finishLoad();
    stage.classList.add('crop-stage-error');
    img.hidden = true;
    $('cropRect').hidden = true;
  };
  img.src = api.cropPageImageUrl(state.currentPdf, page);
}

function clampFrac(v) { return Math.min(1, Math.max(0, v)); }

function renderCropRectUI() {
  const r = state.cropRect;
  const el = $('cropRect');
  el.style.left = (r.left * 100) + '%';
  el.style.top = (r.top * 100) + '%';
  el.style.width = ((r.right - r.left) * 100) + '%';
  el.style.height = ((r.bottom - r.top) * 100) + '%';
  $('cropReadout').textContent =
    `L ${Math.round(r.left * 100)}%  T ${Math.round(r.top * 100)}%  ` +
    `R ${Math.round(r.right * 100)}%  B ${Math.round(r.bottom * 100)}%`;
}

// Drag-to-move (pointerdown inside the rect, not on a handle) and
// drag-to-resize (pointerdown on a corner handle) share one pointer-tracking
// flow: record the starting rect + pointer position, then on move convert
// the pixel delta (relative to the stage's rendered size, so it works at
// any zoom/CSS scale) into a fraction delta and update state.cropRect.
let cropDrag = null; // { mode: 'move'|'resize', handle, startRect, startX, startY }

function cropPointerDown(e, mode, handle) {
  if (!state.cropRect) return;
  e.preventDefault();
  cropDrag = { mode, handle, startRect: { ...state.cropRect }, startX: e.clientX, startY: e.clientY };
  window.addEventListener('pointermove', cropPointerMove);
  window.addEventListener('pointerup', cropPointerUp);
}

function cropPointerMove(e) {
  if (!cropDrag) return;
  const frame = $('cropFrame').getBoundingClientRect();
  const dx = (e.clientX - cropDrag.startX) / frame.width;
  const dy = (e.clientY - cropDrag.startY) / frame.height;
  const s = cropDrag.startRect;
  let r = { ...s };
  if (cropDrag.mode === 'move') {
    const w = s.right - s.left, h = s.bottom - s.top;
    let left = clampFrac(s.left + dx), top = clampFrac(s.top + dy);
    if (left + w > 1) left = 1 - w;
    if (top + h > 1) top = 1 - h;
    r = { left, top, right: left + w, bottom: top + h };
  } else {
    if (cropDrag.handle.includes('w')) r.left = clampFrac(Math.min(s.left + dx, s.right - CROP_MIN_SPAN));
    if (cropDrag.handle.includes('e')) r.right = clampFrac(Math.max(s.right + dx, s.left + CROP_MIN_SPAN));
    if (cropDrag.handle.includes('n')) r.top = clampFrac(Math.min(s.top + dy, s.bottom - CROP_MIN_SPAN));
    if (cropDrag.handle.includes('s')) r.bottom = clampFrac(Math.max(s.bottom + dy, s.top + CROP_MIN_SPAN));
  }
  state.cropRect = r;
  renderCropRectUI();
}

// Drag end auto-saves the rect — no separate save step.
function cropPointerUp() {
  cropDrag = null;
  window.removeEventListener('pointermove', cropPointerMove);
  window.removeEventListener('pointerup', cropPointerUp);
  saveCurrentCrop();
}

async function saveCurrentCrop() {
  try {
    const rect = await api.setCrop(state.currentPdf, state.cropPage, state.cropRect);
    state.cropPages[String(state.cropPage)] = rect;
  } catch (e) { toast(e.message, true); }
}

$('cropRect').addEventListener('pointerdown', (e) => {
  if (e.target.dataset.handle) cropPointerDown(e, 'resize', e.target.dataset.handle);
  else cropPointerDown(e, 'move', null);
});

$('pdfCropToggleBtn').onclick = () => setCropEditing(!state.cropEditing);
$('cropPrevBtn').onclick = () => loadCropPage(state.cropPage - 1);
$('cropNextBtn').onclick = () => loadCropPage(state.cropPage + 1);

$('cropResetBtn').onclick = async () => {
  try {
    await api.deleteCrop(state.currentPdf, state.cropPage);
    delete state.cropPages[String(state.cropPage)];
    state.cropRect = { ...FULL_CROP };
    renderCropRectUI();
    toast('Crop reset');
  } catch (e) { toast(e.message, true); }
};

$('cropApplyAllBtn').onclick = async () => {
  const info = currentPdfInfo();
  const total = (info && info.pages) || 1;
  const choice = await showModal({
    title: 'Apply crop to all pages?',
    message: `Copy this page's crop to all ${total} page${total === 1 ? '' : 's'} of "${titleFromName((state.currentPdf || '').replace(/\.pdf$/i, ''))}"? This overwrites any crops already saved on other pages.`,
    actions: [
      { label: 'Apply to all', value: 'apply', kind: 'primary' },
      { label: 'Cancel', value: null, kind: 'ghost' },
    ],
  });
  if (choice !== 'apply') return;
  try {
    const rect = state.cropRect;
    for (let page = 1; page <= total; page++) {
      const saved = await api.setCrop(state.currentPdf, page, rect);
      state.cropPages[String(page)] = saved;
    }
    toast('Applied to all pages');
  } catch (e) { toast(e.message, true); }
};

setCropEditing(false); // start hidden until "Crop pages" is toggled on

// Highlight the manual-flag toggle buttons that are currently set.
function renderFlagEditor() {
  document.querySelectorAll('.flag-toggle').forEach((btn) => {
    btn.classList.toggle('is-on', state.currentFlags.includes(btn.dataset.flag));
  });
}

function renderPreview(structure) {
  const el = $('preview');
  el.innerHTML = '';
  if (!structure) return;
  const head = document.createElement('div');
  head.innerHTML = `<h3 class="p-title">${esc(structure.title)}</h3>` +
    (structure.author ? `<div class="p-author">${esc(structure.author)}</div>` : '<div class="p-author"></div>');
  el.appendChild(head);
  for (const b of structure.blocks) {
    const div = document.createElement('div');
    div.className = 'p-block ' + b.type;
    for (const line of b.lines) div.appendChild(renderLine(line));
    el.appendChild(div);
  }
}

// Render one lyric line as chords-over-text units.
function renderLine(line) {
  const wrap = document.createElement('div');
  wrap.className = 'p-line';
  const re = /\(([^)]+)\)/g;
  let last = 0, pending = '', m;
  const units = [];
  while ((m = re.exec(line)) !== null) {
    units.push({ chord: pending, text: line.slice(last, m.index) });
    pending = m[1];
    last = m.index + m[0].length;
  }
  units.push({ chord: pending, text: line.slice(last) });
  for (const u of units) {
    if (u.chord === '' && u.text === '') continue;
    const unit = document.createElement('span');
    unit.className = 'p-unit';
    unit.innerHTML = `<span class="p-chord">${esc(u.chord)}</span><span class="p-text">${esc(u.text) || ' '}</span>`;
    wrap.appendChild(unit);
  }
  if (units.every((u) => !u.text && !u.chord)) wrap.innerHTML = '&nbsp;';
  return wrap;
}

function setDirty(d) {
  state.dirty = d;
  $('dirty').hidden = !d;
  $('saveBtn').disabled = !d;
  // Nothing left to write once clean — drop any pending autosave so it
  // can't fire later against a song we've since navigated away from.
  if (!d) clearTimeout(autosaveTimer);
}

// live preview + dirty tracking from the textarea
let previewTimer;
let autosaveTimer;
const AUTOSAVE_DELAY_MS = 2000;
$('source').addEventListener('input', () => {
  setDirty($('source').value !== state.savedContent);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    renderPreview(localParse($('source').value));
  }, 150);
  clearTimeout(autosaveTimer);
  if (state.dirty) autosaveTimer = setTimeout(save, AUTOSAVE_DELAY_MS);
});

// A lightweight mirror of the server parser for instant preview.  The title is
// the filename; the file itself is optional-{directives} (author/history/
// note/flags), then body.
function localParse(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
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
  const author = meta.author || '';
  const body = lines.slice(i).join('\n');
  const blocks = [];
  for (const chunk of body.split(/\n\s*\n/)) {
    const bl = chunk.split('\n').filter((l) => l.length > 0);
    if (!bl.length) continue;
    const isChorus = /^\s*[\(\[]\s*chorus/i.test(bl[0]);
    blocks.push({ type: isChorus ? 'chorus' : 'verse', lines: bl });
  }
  return { title: titleFromName(state.current), author, blocks };
}

async function save() {
  if (!state.current) return;
  const content = $('source').value;
  try {
    const s = await api.save(state.current, content);
    state.savedContent = content;
    setDirty(false);
    renderMeta({ ...s, name: state.current });
    upsertSong(state.current, s);
    renderList();
    toast('Saved');
    refreshHistory();
  } catch (e) { toast(e.message, true); }
}

// ---- toolbar actions ------------------------------------------------------
$('saveBtn').onclick = save;
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
});

function openNewSongRow() {
  $('newSongRow').hidden = false;
  $('newBtn').hidden = true;
  $('newSongInput').value = '';
  $('newSongInput').focus();
}
function closeNewSongRow() {
  $('newSongRow').hidden = true;
  $('newBtn').hidden = false;
}
$('newBtn').onclick = openNewSongRow;
$('newSongCancel').onclick = closeNewSongRow;
$('newSongInput').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeNewSongRow(); }
  if (e.key === 'Enter') { e.preventDefault(); $('newSongConfirm').click(); }
});
$('newSongConfirm').onclick = async () => {
  const name = $('newSongInput').value.trim();
  if (!name) { toast('Enter a filename', true); $('newSongInput').focus(); return; }
  try {
    const created = await api.create(name);
    closeNewSongRow();
    upsertSong(name, created);
    await openSong(name);
    $('songList').querySelector('.song-item.is-active')?.scrollIntoView({ block: 'nearest' });
    toast('Created');
    refreshHistory();
  } catch (e) { toast(e.message, true); }
};

// ---- flag toggles ---------------------------------------------------------
document.getElementById('flagEditor').addEventListener('click', async (e) => {
  const btn = e.target.closest('.flag-toggle');
  if (!btn || !state.current) return;
  const flag = btn.dataset.flag;
  const set = new Set(state.currentFlags);
  if (set.has(flag)) set.delete(flag); else set.add(flag);
  const flags = Array.from(set);

  // Flip the button and sidebar tag immediately — don't make the click wait
  // on the round trip to rewrite the file on disk. Reconciled (or reverted
  // on error) once the request comes back.
  const prevFlags = state.currentFlags;
  state.currentFlags = flags;
  renderFlagEditor();
  upsertSong(state.current, { flags, tags: flags.length ? flags : ['ready'] });
  renderList();

  try {
    const s = await api.setFlags(state.current, flags);
    state.savedContent = s.content;
    $('source').value = s.content;
    setDirty(false);
    renderMeta({ ...s, name: state.current });
    renderPreview(s.structure);
    upsertSong(state.current, s);
    renderList();
    refreshHistory();
  } catch (err) {
    state.currentFlags = prevFlags;
    renderFlagEditor();
    upsertSong(state.current, { flags: prevFlags, tags: prevFlags.length ? prevFlags : ['ready'] });
    renderList();
    toast(err.message, true);
  }
});

// ---- rename (inline title editing) -----------------------------------------
function startRenameEdit() {
  if (!state.current) return;
  const input = $('songTitleInput');
  input.value = state.current;
  $('songTitle').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}
function cancelRenameEdit() {
  $('songTitleInput').hidden = true;
  $('songTitle').hidden = false;
}
async function commitRenameEdit() {
  const input = $('songTitleInput');
  if (input.hidden) return; // already committed/cancelled
  const to = input.value.trim();
  if (!to || to === state.current) { cancelRenameEdit(); return; }
  try {
    await api.rename(state.current, to);
    const prev = state.songs.find((s) => s.name === state.current);
    removeSong(state.current);
    upsertSong(to, { ...prev, name: to, title: titleFromName(to) });
    state.current = to;
    cancelRenameEdit();
    openSong(to);
    toast('Renamed');
    refreshHistory();
  } catch (e) { toast(e.message, true); cancelRenameEdit(); }
}
$('renameBtn').onclick = startRenameEdit;
$('songTitle').addEventListener('click', startRenameEdit);
$('songTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); startRenameEdit(); }
});
$('songTitleInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitRenameEdit(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelRenameEdit(); }
});
$('songTitleInput').addEventListener('blur', commitRenameEdit);

$('deleteBtn').onclick = async () => {
  if (!state.current) return;
  const choice = await showModal({
    title: 'Delete song',
    message: `Delete "${titleFromName(state.current)}"? This cannot be undone.`,
    actions: [
      { label: 'Delete', value: 'delete', kind: 'danger' },
      { label: 'Cancel', value: null, kind: 'ghost' },
    ],
  });
  if (choice !== 'delete') return;
  try {
    await api.remove(state.current);
    removeSong(state.current);
    state.current = null; state.dirty = false;
    $('editor').hidden = true; $('emptyState').hidden = false;
    renderList();
    savePersistedState();
    toast('Deleted');
    refreshHistory();
  } catch (e) { toast(e.message, true); }
};

$('search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); savePersistedState(); });
$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip'); if (!btn) return;
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-active'));
  btn.classList.add('is-active');
  state.filter = btn.dataset.filter;
  renderList();
  savePersistedState();
});

// ---- edit history -----------------------------------------------------------
// A running log of who changed which song/PDF and when (server.js's
// recordEdit()), surfaced as a pill next to the build status showing the
// most recent edit — click it for the full list. Polled on a timer (rather
// than pushed) so edits made by other people editing concurrently show up
// without a page reload.
const EDIT_ACTION_VERB = {
  create: 'created', edit: 'edited', delete: 'deleted', rename: 'renamed',
  flags: 'updated flags on', upload: 'uploaded', replace: 'replaced',
};
function timeAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

let historyEdits = [];
function renderHistoryPill() {
  const pill = $('historyPill');
  const latest = historyEdits[0];
  if (!latest) { pill.textContent = 'no edits yet'; return; }
  const verb = EDIT_ACTION_VERB[latest.action] || latest.action;
  pill.innerHTML =
    `<span class="hp-line hp-who">${esc(latest.user)} ${esc(verb)}</span>` +
    `<span class="hp-line hp-what">${esc(latest.file)} · ${timeAgo(latest.at)}</span>`;
}
function renderHistoryList() {
  const ul = $('historyList');
  ul.innerHTML = '';
  if (!historyEdits.length) {
    ul.innerHTML = '<li class="history-item"><span class="hi-action">No edits recorded yet.</span></li>';
    return;
  }
  for (const e of historyEdits) {
    const verb = EDIT_ACTION_VERB[e.action] || e.action;
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <span class="hi-what">
        <span class="hi-user">${esc(e.user)}</span>
        <span class="hi-action">${esc(verb)} ${esc(e.file)}</span>
      </span>
      <span class="hi-when">${timeAgo(e.at)}</span>`;
    ul.appendChild(li);
  }
}
async function refreshHistory() {
  try {
    const { edits } = await api.edits(200);
    historyEdits = edits;
    renderHistoryPill();
    if (!$('historyDrawer').hidden) renderHistoryList();
  } catch (e) { /* non-critical — leave the last-known pill/list in place */ }
}
$('historyPill').onclick = async () => {
  await refreshHistory();
  renderHistoryList();
  $('historyDrawer').hidden = false;
};
$('closeHistoryDrawer').onclick = () => { $('historyDrawer').hidden = true; };
// Re-render every 30s: relabels "X ago" text as time passes and, via
// refreshHistory, picks up edits made by other people in the meantime.
setInterval(refreshHistory, 30000);

// ---- build ----------------------------------------------------------------
let pollTimer;
function setPill(stateName) {
  const p = $('buildPill');
  p.className = 'pill pill-' + stateName;
  p.textContent = stateName;
  p.hidden = stateName === 'idle';
}
async function refreshBuild() {
  try {
    const st = await api.buildStatus();
    setPill(st.state);
    $('buildLog').textContent = st.log || '(no output yet)';
    $('buildLog').scrollTop = $('buildLog').scrollHeight;
    const done = st.state === 'success' || st.state === 'failed';
    $('viewPdfBtn').disabled = !st.hasPdf;
    if (st.hasPdf) {
      $('pdfLink').hidden = false;
      if (st.state === 'success') {
        $('pdfFrame').src = 'pdf?t=' + (st.pdfMtime || Date.now());
      }
    }
    if (st.state === 'running') {
      $('buildBtn').disabled = true;
      pollTimer = setTimeout(refreshBuild, 1000);
    } else {
      $('buildBtn').disabled = false;
      if (done && st.state === 'success') toast('Build complete');
      if (done && st.state === 'failed') toast('Build failed — see log', true);
    }
  } catch (e) { toast(e.message, true); }
}

$('buildBtn').onclick = async () => {
  if (state.dirty) await save();
  $('drawer').hidden = false;
  $('buildLog').textContent = 'Starting build…';
  try {
    await api.build();
    clearTimeout(pollTimer);
    refreshBuild();
  } catch (e) { toast(e.message, true); }
};
$('viewPdfBtn').onclick = () => {
  $('drawer').hidden = false;
  $('pdfFrame').src = 'pdf?t=' + Date.now();
  refreshBuild();
};
$('closeDrawer').onclick = () => { $('drawer').hidden = true; clearTimeout(pollTimer); };

// ---- build flags ------------------------------------------------------------
// Global on/off switches for optional book content (author/history/note/
// chords/chord diagrams/sheet music), persisted server-side and forwarded to
// the next build. The checkbox itself is the source of truth for its own UI
// state — toggling just persists in the background and reverts on failure.
// New flags just need a `data-flag` checkbox in index.html and a matching
// key in server.js's DEFAULT_BUILD_FLAGS — this code is generic over them.
function renderBuildFlags(flags) {
  document.querySelectorAll('#buildFlags input[data-flag]').forEach((cb) => {
    cb.checked = !!flags[cb.dataset.flag];
  });
}
$('buildFlags').addEventListener('change', async (e) => {
  const cb = e.target.closest('input[data-flag]');
  if (!cb) return;
  const key = cb.dataset.flag;
  const value = cb.checked;
  try {
    await api.setBuildFlags({ [key]: value });
  } catch (err) {
    cb.checked = !value;
    toast(err.message, true);
  }
});

// Reopens whatever was open (and reapplies the search/filter) from a prior
// visit, once the song/PDF list has loaded. Silently no-ops if the saved
// item was since renamed/deleted — the sidebar/empty-state just stays as-is.
async function restorePersistedState() {
  const saved = loadPersistedState();
  if (saved.filter) {
    state.filter = saved.filter;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.filter === saved.filter));
  }
  if (saved.query) {
    state.query = saved.query;
    $('search').value = saved.query;
  }
  renderList();
  if (saved.currentKind === 'pdf' && saved.currentPdf && state.pdfs.some((p) => p.name === saved.currentPdf)) {
    await openPdf(saved.currentPdf);
  } else if (saved.currentKind === 'lyric' && saved.current && state.songs.some((s) => s.name === saved.current)) {
    await openSong(saved.current);
  }
}

// ---- boot -----------------------------------------------------------------
(async function boot() {
  try {
    await refresh();
    refreshHistory();
    renderBuildFlags(await api.getBuildFlags());
    await refreshBuild();
    clearTimeout(pollTimer); // don't keep polling unless a build is running
    const st = await api.buildStatus();
    if (st.state === 'running') refreshBuild();
    await restorePersistedState();
  } catch (e) { toast('Could not load songs: ' + e.message, true); }
})();
