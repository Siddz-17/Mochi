# Mochi 🐶

A pixel-dog desktop companion. Mochi lives in a transparent, always-on-top
window on your desktop: it idles, blinks, follows your cursor with its eyes,
reacts to what its (local, mock) AI brain is doing, and can chat with you
from a pixel-styled panel.

No network calls. No telemetry. All data stays on your machine.

## Setup

Requirements: **Node.js 20+** and **npm**.

```bash
npm install
npm start
```

That's it — a frameless pixel dog appears on your desktop. Drag it anywhere;
its position is remembered between launches.

### Smoke test

```bash
npm run smoke
```

Boots the app headlessly, checks the window/bridge come up, then exits
cleanly. Use it after any change to `electron/` or the renderer entry.

### Hotkeys

| Hotkey             | Action                        |
| ------------------ | ----------------------------- |
| `Cmd/Ctrl+Shift+M` | Toggle the chat panel         |
| `Esc`              | Close settings / panel        |

You can also click Mochi to toggle the panel, and use the tray icon for
show/hide, settings, and quit.

## Configuration

Settings live in `mochi.config.json` (repo root) and are editable from the
in-app Settings dialog (tray → Settings). `bridge.setConfig(patch)` merges a
partial object; the main process persists it.

| Key                  | Type    | Default | Notes                                  |
| -------------------- | ------- | ------- | -------------------------------------- |
| `provider`           | string  | `mock`  | Only `mock` exists. See `docs/ADD_A_PROVIDER.md`. |
| `scale`              | integer | `4`     | Sprite scale, 2–6                      |
| `calmMode`           | boolean | `false` | Fewer animations                       |
| `soundsEnabled`      | boolean | `false` | 8-bit blips, **muted by default**      |
| `userName`           | string  | `""`    | Name Mochi greets you with on boot     |
| `workingFolder`      | string  | `""`    | Project path tools are scoped to       |
| `openAtLogin`        | boolean | `false` | Launch at login (via `bridge.setOpenAtLogin`) |
| `sleepAfterMinutes`  | integer | `5`     | Idle minutes before Mochi naps         |
| `peekMode`           | boolean | `false` | Dog peeks from the screen edge         |
| `pomodoro.enabled`   | boolean | `false` | Pomodoro timer on/off                  |
| `pomodoro.focusMinutes` | integer | `25` | Focus length                            |
| `pomodoro.breakMinutes` | integer | `5`  | Break length                            |
| `reminders.stretch`  | boolean | `true`  | Stretch reminders on/off               |
| `reminders.water`    | boolean | `true`  | Water reminders on/off                 |
| `reminders.intervalMinutes` | integer | `45` | Reminder cadence                 |

The window position is stored separately in `userData/position.json` and is
restored on launch.

## Adding an animation

Sprites are authored as ASCII grids — one `.txt` file per frame — and built
into a sprite sheet. No art tools required.

1. **Draw frames** in `assets/sprites/frames/`, e.g. `wave-0.txt`,
   `wave-1.txt`. Use the characters/legend from `assets/sprites/palette.json`
   (one character per pixel; `.` is transparent).
2. **Build the sheet:**
   ```bash
   npm run build:sprites
   ```
   This writes `assets/spritesheet.png` + `assets/framemap.json`
   (pure-JS PNG writer, no native deps).
3. **Check it** by opening `preview.html` in a browser — it shows every
   animation looping so you can eyeball timing before wiring it into the
   dog's state machine (`src/renderer/dog.js`).

Keep frames small (Mochi renders pixelated at `scale` ×); 2–8 frames per
animation is the norm.

## Packaging

```bash
npx electron-builder
```

Rough outline per OS (see `electron-builder` docs for full config):

- **macOS:** produces a `.dmg` / `.zip`. Notarization needed for smooth
  Gatekeeper experience outside the App Store.
- **Windows:** produces an `.exe` installer (NSIS). Code signing cert
  avoids SmartScreen warnings.
- **Linux:** produces `.AppImage` / `.deb`. **Caveats:** transparent
  frameless windows depend on the compositor — they work on most modern
  Wayland/X11 compositors but can glitch on bare X11 without compositing
  (check `xcompmgr`/`picom`). Tray icons vary by desktop environment;
  test on the target DE.

`npm run dist` (when wired in `package.json`) runs the builder with the
project's config.

## Privacy

- **No network calls, no telemetry, no analytics.** Mochi works fully offline.
- Config, chat history, and window position live in local files only
  (`mochi.config.json`, Electron `userData`).
- API keys for future providers must come from env vars or the OS keychain —
  never committed, never sent anywhere except the provider you configure.
  See `docs/ADD_A_PROVIDER.md`.

## Project structure

```
Mochi/
  package.json               # type: module, scripts: start / build:sprites / smoke
  mochi.config.json          # user config (provider, scale, timers, …)
  electron/
    main.cjs                 # window, tray, globalShortcut, position memory, login toggle
    preload.cjs              # minimal context-isolated bridge (window.mochi)
  src/
    renderer/
      index.html             # #stage (dog canvas) + #effects-layer + #panel + #settings
      styles.css             # pixel UI: chunky borders, pixel font, --ink/--paper/--accent
      dog.js                 # canvas render, state machine, eye-follow, drag, pet
      panel.js               # chat panel, streaming, quick actions, history
      effects.js             # heart / sparkle / zzz / speech-bubble overlays
      settings.js            # settings dialog (this build)
    extras/
      pomodoro.js            # focus/break timer chip (this build)
      reminders.js           # stretch/water reminders + boot greeting (this build)
      sound.js               # WebAudio 8-bit blips, muted by default (this build)
    provider/
      interface.js           # AgentProvider + AgentEvent JSDoc typedefs
      mock.js                # MockProvider (canned replies, tool/approval/error sim)
      registry.js            # provider registry, loads from mochi.config.json
    tools/
      tools.js               # read-only tools scoped to workingFolder
      approval.js            # approve/deny flow for write/shell tools
    state/
      mochiState.js          # MochiState enum + transitions from AgentEvents
  assets/sprites/
    palette.json             # ASCII char → color legend
    frames/*.txt             # hand-drawn animation frames (ASCII grids)
  scripts/
    build-sprites.cjs        # npm run build:sprites → spritesheet.png + framemap.json
    smoke.cjs                # npm run smoke — boot & exit cleanly
  docs/
    ADD_A_PROVIDER.md        # how to plug in a real AI provider (not connected yet)
  preview.html               # static sprite-sheet/animation preview
```

## Accessibility

Mochi respects `prefers-reduced-motion` (animations minimized) and offers a
**calm mode** toggle in Settings that further reduces motion. Sounds are
opt-in and off by default.
