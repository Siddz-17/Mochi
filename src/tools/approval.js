/**
 * @module tools/approval
 *
 * Pixel-styled approval card for write/shell tool requests.
 * Renders into a container (the panel's #approval-area), shows tool name,
 * description, and verbatim detail (command or diff) in a <pre>.
 * Default-denies after 60s with a visible countdown.
 */

const TIMEOUT_S = 60;

/**
 * Render an approval card.
 * @param {HTMLElement} container  Element to render into (cleared first).
 * @param {import('../provider/interface.js').ToolApprovalInfo} req
 * @param {(approved: boolean) => void} onDecision  Called exactly once.
 */
export function renderApprovalCard(container, req, onDecision) {
  if (!container) {
    onDecision(false);
    return;
  }
  container.innerHTML = '';

  const tool = (req && req.tool) || 'unknown tool';
  const description = (req && req.description) || 'A tool wants to run.';
  const detail = req && req.detail != null ? String(req.detail) : '';

  const card = document.createElement('div');
  card.className = 'mochi-approval-card';
  Object.assign(card.style, {
    border: '3px solid #1a1a2e',
    boxShadow: '4px 4px 0 #1a1a2e',
    background: '#fff8e7',
    color: '#1a1a2e',
    fontFamily: '"Courier New", monospace',
    fontSize: '12px',
    padding: '10px',
    margin: '8px 0',
    maxWidth: '100%',
    boxSizing: 'border-box',
  });

  const title = document.createElement('div');
  title.textContent = `⚠ Approve tool: ${tool}`;
  Object.assign(title.style, { fontWeight: 'bold', marginBottom: '6px', fontSize: '13px' });

  const desc = document.createElement('div');
  desc.textContent = description;
  desc.style.marginBottom = '6px';

  const pre = document.createElement('pre');
  pre.textContent = detail;
  Object.assign(pre.style, {
    background: '#1a1a2e',
    color: '#a8ff9e',
    padding: '8px',
    overflow: 'auto',
    maxHeight: '160px',
    fontSize: '11px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    border: '2px solid #000',
    margin: '0 0 8px 0',
  });

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', alignItems: 'center' });

  const btnBase = {
    fontFamily: 'inherit',
    fontSize: '12px',
    fontWeight: 'bold',
    padding: '6px 12px',
    cursor: 'pointer',
    border: '3px solid #1a1a2e',
    boxShadow: '2px 2px 0 #1a1a2e',
  };
  const approveBtn = document.createElement('button');
  approveBtn.textContent = '✔ Approve';
  Object.assign(approveBtn.style, btnBase, { background: '#7dff8a' });
  const denyBtn = document.createElement('button');
  denyBtn.textContent = '✖ Deny';
  Object.assign(denyBtn.style, btnBase, { background: '#ff8a8a' });

  const countdown = document.createElement('span');
  countdown.style.marginLeft = 'auto';
  countdown.style.fontSize = '11px';

  row.append(approveBtn, denyBtn, countdown);
  card.append(title, desc, pre, row);
  container.appendChild(card);

  let remaining = TIMEOUT_S;
  let settled = false;
  const renderCountdown = () => {
    countdown.textContent = `auto-deny in ${remaining}s`;
  };
  renderCountdown();

  const timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      decide(false);
    } else {
      renderCountdown();
    }
  }, 1000);

  function decide(approved) {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    container.innerHTML = '';
    onDecision(!!approved);
  }

  approveBtn.addEventListener('click', () => decide(true));
  denyBtn.addEventListener('click', () => decide(false));

  // Keep keyboard focus visible on the card for quick keyboard approval.
  approveBtn.focus();
}
