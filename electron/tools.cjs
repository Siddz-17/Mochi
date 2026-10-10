/**
 * electron/tools.cjs — main-process tool implementations for Mochi.
 *
 * Called by main's `mochi:invoke-tool` handler as:
 *   invokeTool(name, args, ctx)  with ctx = { root, requestApproval }
 * - `root`: working folder all paths are scoped to.
 * - `requestApproval(info)`: main's approval channel (sends
 *   `mochi:tool-approval` to the renderer and awaits `respondApproval`,
 *   60s timeout → deny). Resolves to boolean.
 *
 * Read-only tools run directly. Write/shell tools MUST obtain approval
 * first; on denial they return {ok:false, denied:true} and do nothing.
 *
 * Hard rules:
 * - Never allow paths outside `root` (absolute or via `..`).
 * - Cap all outputs.
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile, exec } = require('child_process');

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const READ_ONLY = ['files.list', 'files.read', 'files.search', 'git.status', 'git.diff', 'git.log'];

const WRITE_SHELL = new Set(['files.write', 'shell.exec']);

const MAX_READ_BYTES = 64 * 1024;
const MAX_SEARCH_HITS = 50;
const MAX_LIST_ENTRIES = 200;
const MAX_OUTPUT = 100 * 1024; // git diff / shell output cap
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage']);

function fail(error) {
  return { ok: false, error: String(error) };
}

/**
 * Resolve `p` under `root`. Throws on empty input, non-strings, or any
 * resolution escaping root (absolute paths outside root, `..` traversal).
 */
function resolveInRoot(root, p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel === '') return resolved; // root itself
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes working folder: ${p}`);
  }
  return resolved;
}

function relToRoot(root, abs) {
  return path.relative(root, abs) || '.';
}

function truncate(str, max = MAX_OUTPUT) {
  const s = String(str);
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
}

/* ---------------- read-only tools ---------------- */

async function filesList(root, args) {
  const dir = (args && args.dir) || '.';
  let abs;
  try {
    abs = resolveInRoot(root, dir);
  } catch (e) {
    return fail(e.message);
  }
  let entries;
  try {
    entries = await fs.promises.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return fail(`cannot list ${dir}: ${e.message}`);
  }
  const mapped = entries
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    }))
    .sort((a, b) =>
      a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)
    );
  const capped = mapped.slice(0, MAX_LIST_ENTRIES);
  return {
    ok: true,
    dir: relToRoot(root, abs),
    entries: capped,
    truncated: mapped.length > capped.length,
  };
}

async function filesRead(root, args) {
  if (!args || typeof args.path !== 'string') return fail('files.read needs {path}');
  let abs;
  try {
    abs = resolveInRoot(root, args.path);
  } catch (e) {
    return fail(e.message);
  }
  let stat;
  try {
    stat = await fs.promises.stat(abs);
  } catch (e) {
    return fail(`cannot read ${args.path}: ${e.message}`);
  }
  if (!stat.isFile()) return fail(`${args.path} is not a file`);
  const maxBytes = Math.min(Number(args.maxBytes) > 0 ? Number(args.maxBytes) : MAX_READ_BYTES, 1024 * 1024);
  const buf = await fs.promises.readFile(abs);
  const truncated = buf.length > maxBytes;
  return {
    ok: true,
    path: relToRoot(root, abs),
    bytes: buf.length,
    truncated,
    content: buf.slice(0, maxBytes).toString('utf8'),
  };
}

async function filesSearch(root, args) {
  if (!args || typeof args.query !== 'string' || !args.query.trim()) {
    return fail('files.search needs {query}');
  }
  const query = args.query.slice(0, 200).toLowerCase();
  let start;
  try {
    start = resolveInRoot(root, (args && args.dir) || '.');
  } catch (e) {
    return fail(e.message);
  }
  const hits = [];
  async function walk(dir, depth) {
    if (hits.length >= MAX_SEARCH_HITS || depth > 12) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= MAX_SEARCH_HITS) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
      } else if (e.isFile()) {
        let buf;
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > 512 * 1024) continue;
          buf = await fs.promises.readFile(full);
        } catch {
          continue;
        }
        if (buf.includes(0)) continue; // binary
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            hits.push({ path: relToRoot(root, full), line: i + 1, text: lines[i].slice(0, 200) });
          }
        }
      }
    }
  }
  await walk(start, 0);
  return { ok: true, query: args.query, hits, truncated: hits.length >= MAX_SEARCH_HITS };
}

async function runGit(root, gitArgs) {
  try {
    const { stdout } = await execFileAsync('git', gitArgs, {
      cwd: root,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (e) {
    return fail(`git failed: ${e.message}`);
  }
}

async function gitStatus(root) {
  const res = await runGit(root, ['status', '--porcelain=v1']);
  if (!res.ok) return res;
  const files = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim() || '?', path: line.slice(3).trim() }));
  return { ok: true, files };
}

async function gitDiff(root, args) {
  const staged = !!(args && args.staged);
  const gitArgs = ['diff', '--no-color'];
  if (staged) gitArgs.push('--staged');
  const res = await runGit(root, gitArgs);
  if (!res.ok) return res;
  const t = truncate(res.stdout);
  return { ok: true, staged, diff: t.text, truncated: t.truncated };
}

async function gitLog(root, args) {
  const n = Math.min(Math.max(parseInt((args && args.n) || 10, 10) || 10, 1), 50);
  const res = await runGit(root, [
    'log',
    `-n${n}`,
    '--pretty=format:%H%x00%h%x00%an%x00%ad%x00%s',
    '--date=short',
  ]);
  if (!res.ok) return res;
  const commits = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, hash, author, date, subject] = line.split('\x00');
      return { commit, hash, author, date, subject };
    });
  return { ok: true, commits };
}

/* ---------------- write/shell tools (approval-gated) ---------------- */

/** Minimal unified-ish diff of old vs new text for the approval card. */
function makeDiff(oldText, newText, maxLines = 120) {
  const a = (oldText || '').split('\n');
  const b = String(newText).split('\n');
  // Simple LCS-free heuristic: show removed head/tail + added lines. Good enough for a card.
  const out = [];
  if (!oldText) {
    out.push('--- new file ---');
    for (const line of b.slice(0, maxLines)) out.push('+' + line);
    if (b.length > maxLines) out.push(`... (${b.length - maxLines} more lines)`);
    return out.join('\n');
  }
  out.push('--- before', '+++ after');
  const n = Math.max(a.length, b.length);
  let shown = 0;
  for (let i = 0; i < n && shown < maxLines; i++) {
    if (a[i] !== b[i]) {
      if (i < a.length) {
        out.push('-' + a[i]);
        shown++;
      }
      if (i < b.length && shown < maxLines) {
        out.push('+' + b[i]);
        shown++;
      }
    }
  }
  if (n > maxLines && shown >= maxLines) out.push('... (diff truncated)');
  return out.join('\n');
}

async function filesWrite(root, args) {
  if (!args || typeof args.path !== 'string' || typeof args.content !== 'string') {
    return fail('files.write needs {path, content}');
  }
  let abs;
  try {
    abs = resolveInRoot(root, args.path);
  } catch (e) {
    return fail(e.message);
  }
  let existing = null;
  try {
    existing = (await fs.promises.readFile(abs)).toString('utf8');
  } catch {
    existing = null;
  }
  const detail = makeDiff(existing, args.content);
  try {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, args.content, 'utf8');
  } catch (e) {
    return fail(`write failed: ${e.message}`);
  }
  return { ok: true, path: relToRoot(root, abs), bytes: Buffer.byteLength(args.content, 'utf8'), existed: existing !== null, detail };
}

async function shellExec(root, args) {
  if (!args || typeof args.command !== 'string' || !args.command.trim()) {
    return fail('shell.exec needs {command}');
  }
  const command = args.command;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: root,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const out = truncate(stdout);
    const err = truncate(stderr);
    return { ok: true, code: 0, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated };
  } catch (e) {
    const out = truncate(e.stdout || '');
    const err = truncate(e.stderr || e.message || '');
    return { ok: true, code: typeof e.code === 'number' ? e.code : 1, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated };
  }
}

function approvalInfo(name, args, root, extraDetail) {
  if (name === 'files.write') {
    return {
      tool: name,
      args,
      description: `Write file ${args.path} (${Buffer.byteLength(args.content || '', 'utf8')} bytes)`,
      detail: extraDetail || `files.write ${JSON.stringify({ path: args.path })}`,
    };
  }
  return {
    tool: name,
    args,
    description: `Run shell command in ${root}`,
    detail: String(args.command),
  };
}

/**
 * Invoke a tool by name.
 * @param {string} name
 * @param {object} args
 * @param {{root: string, requestApproval: (info: object) => Promise<boolean>}} ctx
 */
async function invokeTool(name, args, ctx) {
  const root = ctx && ctx.root ? path.resolve(ctx.root) : null;
  if (!root) return fail('tool context needs a root working folder');
  try {
    const stat = await fs.promises.stat(root);
    if (!stat.isDirectory()) return fail('tool root is not a directory');
  } catch (e) {
    return fail(`tool root unavailable: ${e.message}`);
  }

  const safeArgs = args && typeof args === 'object' ? args : {};

  if (WRITE_SHELL.has(name)) {
    // Pre-compute the detail shown on the card (diff for writes).
    let detail;
    if (name === 'files.write') {
      try {
        const abs = resolveInRoot(root, safeArgs.path);
        let existing = null;
        try {
          existing = (await fs.promises.readFile(abs)).toString('utf8');
        } catch {
          existing = null;
        }
        detail =
          `files.write ${JSON.stringify({ path: safeArgs.path })}\n` +
          makeDiff(existing, safeArgs.content);
      } catch (e) {
        return fail(e.message);
      }
    }
    const info = approvalInfo(name, safeArgs, root, detail);
    let approved = false;
    try {
      approved = ctx.requestApproval ? await ctx.requestApproval(info) : false;
    } catch {
      approved = false;
    }
    if (!approved) return { ok: false, denied: true };
  }

  switch (name) {
    case 'files.list':
      return filesList(root, safeArgs);
    case 'files.read':
      return filesRead(root, safeArgs);
    case 'files.search':
      return filesSearch(root, safeArgs);
    case 'git.status':
      return gitStatus(root);
    case 'git.diff':
      return gitDiff(root, safeArgs);
    case 'git.log':
      return gitLog(root, safeArgs);
    case 'files.write':
      return filesWrite(root, safeArgs);
    case 'shell.exec':
      return shellExec(root, safeArgs);
    default:
      return fail(`unknown tool: ${name}`);
  }
}

module.exports = { invokeTool, READ_ONLY };
