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
  create: (name, content) => api.req('POST', 'songs', { name, content }),
  remove: (n) => api.req('DELETE', 'songs/' + encodeURIComponent(n)),
  rename: (n, to) => api.req('POST', 'songs/' + encodeURIComponent(n) + '/rename', { to }),
  setFlags: (n, flags) => api.req('POST', 'songs/' + encodeURIComponent(n) + '/flags', { flags }),
  build: () => api.req('POST', 'build'),
  buildStatus: () => api.req('GET', 'build/status'),
};

// Editorial markers stripped from a filename to make a display title.
const EDITORIAL_RE = /\s*[\(\[][^)\]]*\b(needs?|add|find|confirm|check|decide|jonathan|chords?|cords|lyrics|notation|chorus|bridge|verse|tbd|wip)\b[^)\]]*[\)\]]/gi;
const DIRECTIVE_RE = /^\s*\{\s*([a-zA-Z][\w-]*)\s*:\s*(.+?)\s*\}\s*$/;
const titleFromName = (name) => String(name || '').replace(EDITORIAL_RE, '').trim() || String(name || '').trim();

const state = {
  songs: [],
  current: null,      // song name
  currentFlags: [],   // manual flags on the open song
  dirty: false,
  filter: 'all',
  query: '',
  savedContent: '',
};

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

// ---- song list ------------------------------------------------------------
function matchesFilter(s) {
  if (state.filter === 'all') return true;
  return s.tags.includes(state.filter);
}
function renderList() {
  const q = state.query.toLowerCase();
  const items = state.songs.filter((s) =>
    matchesFilter(s) && (!q || s.title.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)));
  $('count').textContent = `${items.length} of ${state.songs.length} songs`;
  const ul = $('songList');
  ul.innerHTML = '';
  for (const s of items) {
    const li = document.createElement('li');
    li.className = 'song-item' + (s.name === state.current ? ' is-active' : '');
    const tag = s.tags[0] || 'ready';
    li.innerHTML = `
      <span class="name">${esc(s.title || s.name)}</span>
      <span class="meta">
        <span class="dot ${tag}">●</span>${esc(s.tags.join(', '))}
        <span>· ${s.lines} lines</span>
        ${s.hasChords ? '<span>· chords</span>' : ''}
      </span>`;
    li.onclick = () => openSong(s.name);
    ul.appendChild(li);
  }
}
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

async function refresh() {
  const { songs } = await api.list();
  state.songs = songs;
  renderList();
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
  state.savedContent = s.content;
  state.dirty = false;
  $('emptyState').hidden = true;
  $('editor').hidden = false;
  $('source').value = s.content;
  setDirty(false);
  renderMeta(s);
  renderPreview(s.structure);
  renderList();
}

function renderMeta(s) {
  $('songTitle').textContent = s.title || titleFromName(s.name);
  $('songAuthor').textContent = s.author || '';
  $('badges').innerHTML = (s.tags || []).map((t) => `<span class="badge ${t}">${t}</span>`).join('') +
    `<span class="badge">${s.bytes} B</span>`;
  state.currentFlags = s.flags || [];
  renderFlagEditor();
}

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
}

// live preview + dirty tracking from the textarea
let previewTimer;
$('source').addEventListener('input', () => {
  setDirty($('source').value !== state.savedContent);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    renderPreview(localParse($('source').value));
  }, 150);
});

// A lightweight mirror of the server parser for instant preview.  The title is
// the filename; the file itself is optional-author, optional-{directives}, body.
function localParse(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  let author = '';
  if (i < lines.length && lines[i].trim() !== '' && !DIRECTIVE_RE.test(lines[i])
      && lines[i].trim().length <= 40
      && (i + 1 >= lines.length || lines[i + 1].trim() === '')
      && !/^\s*[\(\[]/.test(lines[i])) {
    author = lines[i].trim(); i++;
  }
  while (i < lines.length && (lines[i].trim() === '' || DIRECTIVE_RE.test(lines[i]))) i++;
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
    await refresh();
    toast('Saved');
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
    await api.create(name, '');
    closeNewSongRow();
    await refresh();
    openSong(name);
    toast('Created');
  } catch (e) { toast(e.message, true); }
};

// ---- flag toggles ---------------------------------------------------------
document.getElementById('flagEditor').addEventListener('click', async (e) => {
  const btn = e.target.closest('.flag-toggle');
  if (!btn || !state.current) return;
  const flag = btn.dataset.flag;
  const set = new Set(state.currentFlags);
  if (set.has(flag)) set.delete(flag); else set.add(flag);
  try {
    const s = await api.setFlags(state.current, Array.from(set));
    state.savedContent = s.content;
    $('source').value = s.content;
    setDirty(false);
    renderMeta({ ...s, name: state.current });
    renderPreview(s.structure);
    await refresh();
  } catch (err) { toast(err.message, true); }
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
    state.current = to;
    cancelRenameEdit();
    await refresh();
    openSong(to);
    toast('Renamed');
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
    state.current = null; state.dirty = false;
    $('editor').hidden = true; $('emptyState').hidden = false;
    await refresh();
    toast('Deleted');
  } catch (e) { toast(e.message, true); }
};

$('search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip'); if (!btn) return;
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-active'));
  btn.classList.add('is-active');
  state.filter = btn.dataset.filter;
  renderList();
});

// ---- build ----------------------------------------------------------------
let pollTimer;
function setPill(stateName) {
  const p = $('buildPill');
  p.className = 'pill pill-' + stateName;
  p.textContent = stateName;
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

// ---- boot -----------------------------------------------------------------
(async function boot() {
  try {
    await refresh();
    await refreshBuild();
    clearTimeout(pollTimer); // don't keep polling unless a build is running
    const st = await api.buildStatus();
    if (st.state === 'running') refreshBuild();
  } catch (e) { toast('Could not load songs: ' + e.message, true); }
})();
