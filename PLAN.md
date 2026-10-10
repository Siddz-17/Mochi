# Mochi — Build Plan

## Repo inspection
- Remote `Siddz-17/Mochi` exists on GitHub, public, empty (no commits).
- Local workspace empty → greenfield. No language/package manager yet.
- Decision: **Electron + JavaScript (CommonJS)** for `npm install && npm start`. No TS build step to keep smoke simple. JSDoc types for the provider interface.

## Stack choice
- **Electron** (v30+): transparent, frameless, always-on-top, tray, globalShortcut.
- Renderer: vanilla JS + Canvas 2D with `imageSmoothingEnabled=false`, CSS `image-rendering: pixelated`.
- Sprites: authored as ASCII grids in `assets/sprites/frames/*.txt` + `palette.json`; build script `scripts/build-sprites.js` (Node, no deps, uses `pngjs`-free manual PNG? — simpler: use canvas-free pure-JS PNG encoder vendored, or output via Node + `sharp`? To avoid native deps, write minimal PNG writer in pure JS) → `assets/spritesheet.png` + `framemap.json`.
- Preview: `preview.html` (static, opens sprite sheet + animations).
- Config: `mochi.config.json` (`provider: "mock"`).
- No network calls, no telemetry, all local.

## File tree (to add)
```
Mochi/
  package.json
  mochi.config.json
  electron/main.js          # window, tray, shortcuts, position memory, login toggle
  electron/preload.js       # minimal bridge (contextIsolation on)
  src/renderer/index.html
  src/renderer/styles.css   # pixel UI, chunky borders, pixel font (system monospace styled)
  src/renderer/dog.js       # canvas render, state machine, eye-follow, drag, pet
  src/renderer/panel.js     # chat panel, streaming, quick actions, history
  src/renderer/effects.js   # heart/sparkle/z/bubbles overlays
  src/provider/interface.js # JSDoc AgentProvider + AgentEvent typedefs
  src/provider/mock.js      # MockProvider (canned, delays, tool/approval/error sim)
  src/provider/registry.js  # registry + load from mochi.config.json
  src/tools/tools.js        # read-only tools scoped to repo root
  src/tools/approval.js     # approve/deny flow for write/shell
  src/state/mochiState.js   # MochiState enum + transitions from AgentEvents
  src/extras/pomodoro.js
  src/extras/reminders.js
  assets/sprites/palette.json
  assets/sprites/frames/*.txt  # ~24 animations x 2-8 frames
  assets/sprites/build.js
  docs/ADD_A_PROVIDER.md
  README.md
  scripts/smoke.js
  preview.html
```

## Milestones & verification
1. **Transparent window + static dog + drag + position memory** — `npm start` shows frameless dog, drag moves, relaunch restores pos, tray exists.
2. **Sprite pipeline + idle anims + eye-follow** — `npm run build:sprites` → PNG+JSON; `preview.html` shows all anims; dog blinks 3–6s, eyes follow cursor.
3. **Chat panel + MockProvider** — click dog / Cmd+Shift+M toggles pixel panel; streams mock replies; history persists to userData.
4. **Agent-state reactions** — mock emits thinking/working/approval/done/error; dog shows think/work/alert-bark/hop/sad + bubbles.
5. **Tool layer + approval** — read-only tools work scoped to repo root; mock triggers tool request → in-panel approve/deny card; default deny.
6. **Extras, tray, packaging** — pomodoro, reminders, greet-by-name, peek mode, sounds (muted), calm mode + reduce-motion, `npm run dist` notes, README, smoke script `npm run smoke` boots & exits cleanly.

## Defaults chosen (no blockers)
- Scale default 4x, setting 2x–6x integer only.
- Sleep after 5 min idle; calm mode toggle; sounds muted by default.
- Hotkey: CmdOrCtrl+Shift+M. Position file: `userData/position.json`.
- Name for greeting: from OS username, editable in Settings.
