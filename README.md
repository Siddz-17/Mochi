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
| `Cmd/Ctrl+Shift+M` | Toggle the chat panel (default) |
| `Esc`              | Close settings / panel        |

The panel hotkey is **customizable**: Settings → SYSTEM → click the combo
button, then press your keys (`Esc` cancels). If a combo can't be registered
(already taken, malformed), Mochi keeps the previous one and tells you.

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
| `autoUpdate`         | boolean | `false` | Opt-in updater (Settings checkbox / `bridge.setAutoUpdate`) |
| `panelHotkey`        | string  | `CmdOrCtrl+Shift+M` | Global shortcut for the chat panel; customizable in Settings |
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

Packaging is wired with [`electron-builder`](https://www.electron.build/)
(see the `build` config in `package.json`):

```bash
npm run dist        # builds installers into dist/
```

- **macOS:** `.dmg` + `.zip` (category `public.app-category.utilities`).
- **Windows:** NSIS `.exe` installer.
- **Linux:** `.AppImage`.

Included files: `electron/**`, `src/**`, `assets/**`, `mochi.config.json`,
`package.json`.

**Caveats:**

- **macOS notarization** is needed for a smooth Gatekeeper experience
  outside the App Store. Sign + notarize with `notarytool` before
  distributing a `.dmg`; see electron-builder's
  [notarization docs](https://www.electron.build/configuration/mac.html#notarization).
  Unsigned builds will trigger the "cannot be opened" Gatekeeper prompt.
- **Windows SmartScreen:** an EV/OV code-signing certificate avoids
  SmartScreen warnings on the NSIS installer. Unsigned installers show a
  blue "unknown publisher" prompt.
- **Linux transparency:** transparent frameless windows depend on the
  compositor — they work on most modern Wayland/X11 compositors but can
  glitch on bare X11 without compositing (check `xcompmgr`/`picom`). Tray
  icons vary by desktop environment; test on the target DE.

### Auto-update

Updates ship via **GitHub Releases** (see `build.publish` in
`package.json`), delivered by
[`electron-updater`](https://www.electron.build/auto-update.html).
It is **opt-in and off by default**: with `autoUpdate: false` (the default)
Mochi makes zero network calls for updates.

To turn it on, tick the **Auto-update** checkbox in Settings → SYSTEM
(or set `"autoUpdate": true` in `mochi.config.json`). When enabled, Mochi:

1. checks for updates at launch and every 6 hours,
2. auto-downloads new releases,
3. shows a dialog ("Install and restart" / "Later") before installing.

Checking manually is possible with `window.mochi.checkForUpdatesNow()`
(a no-op unless auto-update is enabled).

## Privacy

- **No network calls, no telemetry, no analytics** in default configuration —
  Mochi works fully offline. The only exception is **auto-update**, which is
  strictly opt-in (off by default) and checks GitHub Releases only when you
  enable it. See "Auto-update" under Packaging.
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
    main.cjs                 # window, tray, custom panel hotkey, single-instance lock, crash recovery
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

## Performance

### Measuring idle CPU

"idle" means: the dog is sitting on your desktop, the chat panel is closed,
and no timers (pomodoro/reminders) are firing. To measure Mochi's footprint
in that state:

- **macOS:** open Activity Monitor → CPU tab → find `Mochi`, read the
  `% CPU` column.
- **Linux:** run `htop` (or `top`), filter for `mochi`/`electron`, read
  `%CPU`.
- **Windows:** open Task Manager → Details tab → find `Mochi.exe`, read the
  CPU column.

Watch the value for a minute or two and note the average and any spikes
(blinks and eye-follow wake the renderer briefly). If you change settings
such as `scale` or `calmMode`, measure again before/after so you're comparing
the same workload. Record the OS, Electron version, and exact idle
conditions alongside the numbers — "idle" numbers are meaningless without
them.
