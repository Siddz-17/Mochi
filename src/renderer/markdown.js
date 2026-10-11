/**
 * @module renderer/markdown
 *
 * Tiny zero-dependency markdown renderer for Mochi's chat panel.
 * Supports: headings (#/##/###), bold **x**, italic *x*, inline `code`,
 * fenced ``` blocks (optional language label), unordered lists (- or *),
 * ordered lists (1.), and links [text](url).
 *
 * Safety: all source text is HTML-escaped BEFORE any token rule runs, and
 * the markup we generate only ever embeds that escaped text (plus the fixed
 * set of tags we emit ourselves). Link URLs are restricted to
 * http(s):// and mailto: so `javascript:` URLs can never reach an href.
 * Rendered assistant output is therefore safe to inject via innerHTML.
 */

/** Escape the five HTML-significant characters. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Private-use placeholders so inline code spans survive the later
// bold/italic/link passes untouched.
const PH_OPEN = '';
const PH_CLOSE = '';

/**
 * Inline rules applied to already-escaped text: `code`, [links](url),
 * **bold**, *italic*.
 * @param {string} src escaped source text (no raw HTML in it)
 * @returns {string} HTML
 */
function inline(src) {
  let s = src;
  const codes = [];
  // Inline code first — its contents must not be touched by later rules.
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code class="mochi-md-code">${code}</code>`);
    return `${PH_OPEN}${codes.length - 1}${PH_CLOSE}`;
  });
  // Links. The URL is already HTML-escaped (quotes became &quot;), so it is
  // safe inside the attribute; unsafe schemes are demoted to plain text.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    if (!/^(https?:|mailto:)/i.test(url)) return text;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  // Restore the protected code spans.
  s = s.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g'), (_, k) => codes[Number(k)] ?? '');
  return s;
}

/**
 * Render a markdown-ish string to safe HTML.
 * @param {string} src
 * @returns {string} HTML string, safe for innerHTML
 */
export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const n = lines.length;
  let i = 0;

  const isFence = (l) => /^```/.test(l);
  const isHeading = (l) => /^(#{1,3})\s+/.test(l);
  const isUList = (l) => /^\s{0,3}[-*]\s+\S/.test(l);
  const isOList = (l) => /^\s{0,3}\d+\.\s+\S/.test(l);
  const isBlockStart = (l) => isFence(l) || isHeading(l) || isUList(l) || isOList(l);

  while (i < n) {
    const line = lines[i];

    // Fenced code block (unclosed fence runs to end of input).
    if (isFence(line)) {
      const lang = line
        .replace(/^```/, '')
        .trim()
        .replace(/[^\w+-]/g, '')
        .slice(0, 24);
      const buf = [];
      i += 1;
      while (i < n && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < n) i += 1; // consume the closing fence
      const code = escapeHtml(buf.join('\n')) || ' ';
      const langHtml = lang ? `<span class="mochi-code-lang">${lang}</span>` : '';
      out.push(
        `<pre class="mochi-codeblock"${lang ? ` data-lang="${lang}"` : ''}>` +
          `${langHtml}<button type="button" class="mochi-copy-btn" title="Copy code">copy</button>` +
          `<code>${code}</code></pre>`
      );
      continue;
    }

    // Headings.
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level} class="mochi-md-h">${inline(escapeHtml(h[2]))}</h${level}>`);
      i += 1;
      continue;
    }

    // Unordered list — group consecutive items.
    if (isUList(line)) {
      const items = [];
      while (i < n && isUList(lines[i])) {
        items.push(`<li>${inline(escapeHtml(lines[i].replace(/^\s{0,3}[-*]\s+/, '')))}</li>`);
        i += 1;
      }
      out.push(`<ul class="mochi-md-list">${items.join('')}</ul>`);
      continue;
    }

    // Ordered list — group consecutive items.
    if (isOList(line)) {
      const items = [];
      while (i < n && isOList(lines[i])) {
        items.push(`<li>${inline(escapeHtml(lines[i].replace(/^\s{0,3}\d+\.\s+/, '')))}</li>`);
        i += 1;
      }
      out.push(`<ol class="mochi-md-list">${items.join('')}</ol>`);
      continue;
    }

    // Blank line: paragraph separator.
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // Paragraph: gather lines until a blank line or another block.
    const buf = [];
    while (i < n && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p class="mochi-md-p">${inline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`);
  }

  return out.join('\n');
}

/**
 * Copy text to the clipboard. Tries navigator.clipboard first, falls back
 * to a hidden textarea + execCommand for older contexts.
 * @param {string} text
 * @returns {Promise<boolean>} true when the copy succeeded
 */
export async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}

/**
 * Wire the copy buttons inside rendered markdown. Each
 * `pre.mochi-codeblock > button.mochi-copy-btn` copies its sibling `code`
 * element's text and flashes "copied ✓" / "copy ✗" feedback.
 * Idempotent: a button is never wired twice.
 * @param {Element} root element containing rendered markdown
 * @returns {number} how many buttons were wired
 */
export function attachCopyButtons(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  let count = 0;
  const pres = root.querySelectorAll('pre.mochi-codeblock');
  for (const pre of pres) {
    if (!pre || typeof pre.querySelector !== 'function') continue;
    const btn = pre.querySelector('.mochi-copy-btn');
    const code = pre.querySelector('code');
    if (!btn || !code || btn.dataset.wired) continue;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const ok = await copyText(code.textContent);
      const prev = btn.textContent;
      btn.textContent = ok ? 'copied ✓' : 'copy ✗';
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    });
    count += 1;
  }
  return count;
}
