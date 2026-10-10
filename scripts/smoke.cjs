'use strict';
/*
 * Mochi smoke test — boots the Electron app headless and waits for SMOKE OK.
 *
 * Usage:  npm run smoke        (or: node scripts/smoke.cjs)
 * Exits 0 when the app prints "SMOKE OK" within 45s, else exits 1 and
 * dumps the captured child logs. No other agent will run npm install,
 * so this script must work straight after `npm install`.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 45_000;

let electronBin;
try {
  electronBin = require('electron'); // the package exports the binary path
} catch (err) {
  console.error('[smoke] electron is not installed. Run `npm install` first.');
  process.exit(1);
}
if (typeof electronBin !== 'string' || electronBin.length === 0) {
  console.error('[smoke] could not resolve the electron binary path.');
  process.exit(1);
}

// Chromium refuses to start as root unless --no-sandbox is on the real
// command line (a JS appendSwitch in main.cjs runs too late — the check
// happens in the native delegate before Node boots). Pass it when spawning.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const noSandboxArgs = isRoot ? ['--no-sandbox'] : [];
const useXvfb = process.platform !== 'win32' && !process.env.DISPLAY;
const cmd = useXvfb ? 'xvfb-run' : electronBin;
const args = useXvfb
  ? ['-a', electronBin, ...noSandboxArgs, '.', '--smoke']
  : [...noSandboxArgs, '.', '--smoke'];

console.log(`[smoke] launching: ${cmd} ${args.join(' ')}`);

const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

let stdout = '';
let stderr = '';
let done = false;

const timer = setTimeout(() => finish(1, 'timed out waiting for SMOKE OK (45s)'), TIMEOUT_MS);

function finish(code, reason) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (code === 0) {
    console.log('[smoke] PASS — app printed SMOKE OK');
    process.exit(0);
  }
  console.error(`[smoke] FAIL — ${reason}`);
  if (stdout) console.error('--- captured stdout ---\n' + stdout);
  if (stderr) console.error('--- captured stderr ---\n' + stderr);
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
  process.exit(1);
}

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  stdout += text;
  if (text.includes('SMOKE FAIL')) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    finish(1, 'app reported SMOKE FAIL');
  }
  if (text.includes('SMOKE OK')) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    finish(0);
  }
});

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

child.on('error', (err) => {
  finish(1, `failed to spawn child process: ${err.message}`);
});

child.on('exit', (code, signal) => {
  if (!done) {
    finish(1, `app exited before printing SMOKE OK (code=${code}, signal=${signal})`);
  }
});
