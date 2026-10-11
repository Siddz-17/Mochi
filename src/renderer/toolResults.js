/**
 * @module renderer/toolResults
 *
 * Rich tool-result rendering for the chat panel:
 *  - unified diffs render inside pixel-styled collapsible blocks, with
 *    per-file sections when the diff spans multiple files (+/- lines
 *    colored from the styles.css palette);
 *  - long outputs (>60 lines or >4000 chars) are truncated with a pixel
 *    "show more / show less" toggle. The full text is always kept in
 *    memory (module state + export log) so truncation never destroys
 *    data for copy/export;
 *  - a copy button copies the full (untruncated) output.
 *
 * The HTML builders (`describeResult`, `isDiffText`, `parseDiff`,
 * `truncateForDisplay`, `renderToolHtml`) are pure and DOM-free so they
 * can be unit-tested in plain node. `createToolResultElement` is the thin
 * DOM wrapper the panel uses; it wires toggle/copy clicks by delegation.
 */

const TRUNC_LINES = 60;
const TRUNC_CHARS = 4000;
const EXPORT_CAP = 20000;

let seq = 0;
const blocks = new Map(); // uid -> { ev, desc, full, expanded, bodyOpen, fileOpen: Map }
const exportLog = []; // [{ tool, id, ok, text }] in render order; in-memory only

/* ------------------------------------------------------------------ utils */

export function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** True when `text` looks like a unified diff (git diff output or the
 *  unified-ish diff tools.cjs builds for the files.write approval card). */
export function isDiffText(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return /^(diff --git |@@ |--- |\+\+\+ )/m.test(text);
}

/**
 * Split a unified diff into per-file sections.
 * @returns {Array<{path: string, lines: Array<{t: 'meta'|'hunk'|'add'|'del'|'ctx', text: string}>, adds: number, dels: number}>}
 */
export function parseDiff(text) {
  const files = [];
  let cur = null;
  const startFile = (p) => {
    cur = { path: p || '(unknown file)', lines: [], adds: 0, dels: 0 };
    files.push(cur);
  };
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
      startFile(m ? m[2] : line.slice('diff --git '.length));
      cur.lines.push({ t: 'meta', text: line });
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      if (cur) cur.path = p || cur.path;
      else startFile(p);
      cur.lines.push({ t: 'meta', text: line });
    } else if (line.startsWith('--- ')) {
      if (!cur) startFile(line.slice(4).replace(/^a\//, ''));
      cur.lines.push({ t: 'meta', text: line });
    } else if (line.startsWith('@@')) {
      if (!cur) startFile('');
      cur.lines.push({ t: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      if (!cur) startFile('');
      cur.lines.push({ t: 'add', text: line });
      cur.adds += 1;
    } else if (line.startsWith('-')) {
      if (!cur) startFile('');
      cur.lines.push({ t: 'del', text: line });
      cur.dels += 1;
    } else {
      if (!cur) startFile('');
      cur.lines.push({ t: 'ctx', text: line });
    }
  }
  return files;
}

/**
 * Truncate long text for display. Never mutates the input.
 * @returns {{shown: string, truncated: boolean, hiddenLines: number, totalLines: number, totalChars: number}}
 */
export function truncateForDisplay(text) {
  const s = String(text);
  const lines = s.split('\n');
  let shownLines = lines;
  let cutByLines = false;
  if (lines.length > TRUNC_LINES) {
    shownLines = lines.slice(0, TRUNC_LINES);
    cutByLines = true;
  }
  let shown = shownLines.join('\n');
  if (shown.length > TRUNC_CHARS) {
    // Cut back to the previous newline so we never split a line mid-way.
    const cut = shown.slice(0, TRUNC_CHARS);
    const nl = cut.lastIndexOf('\n');
    shown = nl > 0 ? cut.slice(0, nl) : cut;
  }
  const truncated = cutByLines || shown.length < s.length;
  return {
    shown,
    truncated,
    hiddenLines: Math.max(0, lines.length - shown.split('\n').length),
    totalLines: lines.length,
    totalChars: s.length,
  };
}

/* ------------------------------------------------------- result shaping
   tool-result events carry {id, ok, result?, error?} — no tool name — so
   the payload is recognized by shape (mirrors electron/tools.cjs). */

function fmtList(r) {
  const entries = Array.isArray(r.entries) ? r.entries : [];
  const lines = entries.map((e) =>
    e && e.type === 'dir' ? `${e.name}/` : String((e && e.name) || '')
  );
  let text = lines.join('\n');
  if (r.truncated) text += '\n… (list truncated)';
  return { title: `files.list · ${r.dir || '.'}`, text, note: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` };
}

function fmtRead(r) {
  const note = r.truncated ? ` · truncated at ${r.bytes} bytes` : '';
  return { title: `files.read · ${r.path || '?'}`, text: String(r.content == null ? '' : r.content), note };
}

function fmtSearch(r) {
  const hits = Array.isArray(r.hits) ? r.hits : [];
  const lines = hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
  let text = lines.join('\n');
  if (!lines.length) text = '(no matches)';
  if (r.truncated) text += '\n… (hit cap reached)';
  return { title: `files.search · “${r.query || ''}”`, text, note: `${hits.length} hit${hits.length === 1 ? '' : 's'}` };
}

function fmtStatus(r) {
  const files = Array.isArray(r.files) ? r.files : [];
  const text = files.length
    ? files.map((f) => `${String(f.status || '?').padEnd(2)} ${f.path}`).join('\n')
    : '(working tree clean)';
  return { title: 'git.status', text, note: `${files.length} changed` };
}

function fmtDiff(r, toolName) {
  const text = String(r.diff == null ? '' : r.diff);
  const note = r.truncated ? ' · truncated by tools.cjs' : '';
  return { title: `${toolName} · ${r.staged ? 'staged' : 'unstaged'}`, text, note };
}

function fmtLog(r) {
  const commits = Array.isArray(r.commits) ? r.commits : [];
  const text = commits.length
    ? commits.map((c) => `${c.hash} ${c.date} ${c.subject} — ${c.author}`).join('\n')
    : '(no commits)';
  return { title: 'git.log', text, note: `${commits.length} commit${commits.length === 1 ? '' : 's'}` };
}

function fmtWrite(r) {
  const detail = String(r.detail == null ? '' : r.detail);
  return {
    title: `files.write · ${r.path || '?'}`,
    text: detail,
    note: `${r.bytes || 0} bytes${r.existed ? '' : ' · new file'}`,
  };
}

function fmtShell(r) {
  const parts = [];
  if (r.stdout) parts.push(`$ exit ${r.code == null ? '?' : r.code}\n${r.stdout}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  let text = parts.join('\n') || '(no output)';
  if (r.truncated) text += '\n… (output truncated)';
  return { title: 'shell.exec', text, note: `exit ${r.code == null ? '?' : r.code}` };
}

function fmtJson(r, toolName) {
  return { title: toolName, text: JSON.stringify(r, null, 2), note: '' };
}

/**
 * Describe a tool-result event for rendering. Pure.
 * @returns {{ok: boolean, toolName: string, title: string, note: string, bodyText: string, isDiff: boolean, statusText: string}}
 */
export function describeResult(ev) {
  const id = (ev && ev.id) || 'tool';
  if (!ev || !ev.ok) {
    const err = (ev && ev.error) || 'tool failed';
    return {
      ok: false,
      toolName: id,
      title: id,
      note: '',
      bodyText: String(err),
      isDiff: false,
      statusText: `✗ ${id} failed`,
    };
  }
  const r = ev.result && typeof ev.result === 'object' ? ev.result : {};
  let f;
  if (typeof r.diff === 'string' && ('staged' in r || 'ok' in r)) f = fmtDiff(r, 'git.diff');
  else if (Array.isArray(r.entries)) f = fmtList(r);
  else if ('content' in r && ('path' in r || 'bytes' in r)) f = fmtRead(r);
  else if (Array.isArray(r.hits)) f = fmtSearch(r);
  else if (Array.isArray(r.commits)) f = fmtLog(r);
  else if (Array.isArray(r.files) && !('diff' in r)) f = fmtStatus(r);
  else if (typeof r.detail === 'string' && 'path' in r) f = fmtWrite(r);
  else if ('stdout' in r || 'stderr' in r) f = fmtShell(r);
  else f = fmtJson(r, id);
  const bodyText = f.text || '(empty result)';
  const isDiff = isDiffText(bodyText);
  const statusText = `✓ ${id} ok`;
  let title = [f.title, f.note].filter(Boolean).join(' · ');
  if (isDiff) {
    // Summarize the whole diff in the header: file count + added/removed lines.
    title += ` · ${diffCountsLabel(parseDiff(bodyText))}`;
  }
  return { ok: true, toolName: id, title, note: f.note, bodyText, isDiff, statusText };
}

/* ------------------------------------------------------------------ html */

function diffCountsLabel(files) {
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  const n = files.length;
  return `${n} file${n === 1 ? '' : 's'} · +${adds}/−${dels}`;
}

function renderDiffLines(lines) {
  return lines
    .map(({ t, text }) => {
      const cls = t === 'add' ? 'tr-add' : t === 'del' ? 'tr-del' : t === 'hunk' ? 'tr-hunk' : t === 'meta' ? 'tr-meta' : 'tr-ctx';
      // Keep empty lines visible inside <pre>.
      return `<span class="${cls}">${escHtml(text) || ' '}</span>`;
    })
    .join('\n');
}

/** Body HTML for a diff result given its (possibly truncated) text and per-file open state. */
function renderDiffBody(state, text) {
  const files = parseDiff(text);
  if (!files.length) return `<pre class="tr-pre">(empty diff)</pre>`;
  return files
    .map((f, i) => {
      const open = state.fileOpen.has(i) ? state.fileOpen.get(i) : files.length === 1;
      const arrow = open ? '▾' : '▸';
      const body = open
        ? `<pre class="tr-pre tr-diff-lines">${renderDiffLines(f.lines)}</pre>`
        : '';
      return (
        `<div class="tr-diff-file">` +
        `<button type="button" class="tr-diff-head" data-tr-action="toggle-file" data-tr-file="${i}">` +
        `<span class="tr-arrow">${arrow}</span> <span class="tr-filename">${escHtml(f.path)}</span> ` +
        `<span class="tr-counts">+${f.adds}/−${f.dels}</span></button>${body}</div>`
      );
    })
    .join('');
}

function renderBody(state) {
  const { desc, expanded, full } = state;
  if (desc.isDiff) {
    const text = expanded ? full : truncateForDisplay(full).shown;
    const trunc = truncateForDisplay(full);
    const moreBtn =
      trunc.truncated && !expanded
        ? `<button type="button" class="tr-showmore" data-tr-action="show-more">▸ show more (${trunc.hiddenLines} more lines)…</button>`
        : trunc.truncated && expanded
          ? `<button type="button" class="tr-showmore" data-tr-action="show-less">▾ show less</button>`
          : '';
    return renderDiffBody(state, text) + moreBtn;
  }
  const trunc = truncateForDisplay(full);
  const shown = expanded ? full : trunc.shown;
  const moreBtn =
    trunc.truncated && !expanded
      ? `<button type="button" class="tr-showmore" data-tr-action="show-more">▸ show more (${trunc.hiddenLines} more lines)…</button>`
      : trunc.truncated && expanded
        ? `<button type="button" class="tr-showmore" data-tr-action="show-less">▾ show less</button>`
        : '';
  return `<pre class="tr-pre">${escHtml(shown)}</pre>${moreBtn}`;
}

/**
 * Full inner HTML for a tool-result block (pure — no DOM).
 * @param {object} ev tool-result event
 * @param {string} uid unique block id
 */
export function renderToolHtml(ev, uid) {
  const desc = describeResult(ev);
  const state = {
    uid,
    ev,
    desc,
    full: desc.bodyText,
    expanded: false,
    bodyOpen: true,
    fileOpen: new Map(),
  };
  return { html: renderBlockHtml(state), state };
}

function renderBlockHtml(state) {
  const { desc, bodyOpen } = state;
  const statusCls = desc.ok ? 'tr-ok' : 'tr-err';
  const body = bodyOpen ? `<div class="tr-body">${renderBody(state)}</div>` : '';
  return (
    `<div class="tr-header">` +
    `<button type="button" class="tr-toggle" data-tr-action="toggle-body" title="Show/hide output"><span class="tr-arrow">${bodyOpen ? '▾' : '▸'}</span></button>` +
    `<span class="tr-status ${statusCls}">${escHtml(desc.statusText)}</span>` +
    `<span class="tr-title">${escHtml(desc.title)}</span>` +
    `<button type="button" class="tr-copy" data-tr-action="copy" title="Copy full output">copy</button>` +
    `</div>${body}`
  );
}

/* ------------------------------------------------------- dom wrapper */

function handleClick(e, state, el) {
  const btn = e.target && e.target.closest ? e.target.closest('[data-tr-action]') : null;
  if (!btn || !el.contains(btn)) return;
  const action = btn.getAttribute('data-tr-action');
  if (action === 'copy') {
    const label = btn.textContent;
    try {
      const done = () => {
        btn.textContent = 'copied!';
        setTimeout(() => {
          btn.textContent = label;
        }, 1200);
      };
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(state.full).then(done, done);
      } else {
        done();
      }
    } catch {
      /* clipboard unavailable — still flash the label */
    }
    return;
  }
  if (action === 'toggle-body') {
    state.bodyOpen = !state.bodyOpen;
  } else if (action === 'toggle-file') {
    const i = Number(btn.getAttribute('data-tr-file'));
    const files = parseDiff(state.expanded ? state.full : truncateForDisplay(state.full).shown);
    const cur = state.fileOpen.has(i) ? state.fileOpen.get(i) : files.length === 1;
    state.fileOpen.set(i, !cur);
  } else if (action === 'show-more') {
    state.expanded = true;
  } else if (action === 'show-less') {
    state.expanded = false;
  } else {
    return;
  }
  el.innerHTML = renderBlockHtml(state);
}

/**
 * Build a DOM element for a tool-result event and register its full text
 * for copy/export. The panel appends this into #messages.
 * @param {object} ev tool-result event
 * @returns {HTMLElement}
 */
export function createToolResultElement(ev) {
  const uid = `tr${(seq += 1)}`;
  const desc = describeResult(ev);
  const state = {
    uid,
    ev,
    desc,
    full: desc.bodyText,
    expanded: false,
    bodyOpen: true,
    fileOpen: new Map(),
  };
  blocks.set(uid, state);
  exportLog.push({ tool: desc.toolName, id: (ev && ev.id) || uid, ok: desc.ok, text: desc.bodyText });
  const el = document.createElement('div');
  el.className = 'tr-wrap';
  el.dataset.trUid = uid;
  el.innerHTML = renderBlockHtml(state);
  el.addEventListener('click', (e) => handleClick(e, state, el));
  return el;
}

/** Full (untruncated) tool outputs rendered so far, for chat export. In-memory only. */
export function getToolExport() {
  return exportLog.map((e) => ({
    tool: e.tool,
    id: e.id,
    ok: e.ok,
    text: e.text.length > EXPORT_CAP ? e.text.slice(0, EXPORT_CAP) + '\n… (capped in export)' : e.text,
  }));
}

/** Test seam: reset in-memory block/export state. */
export function __resetForTest() {
  seq = 0;
  blocks.clear();
  exportLog.length = 0;
}
