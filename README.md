# Mochi 🐕

A delightful desktop companion for your screen:
1. **A pixel-sprite white Japanese dog** that idles, blinks, follows your cursor with its eyes, gets petted, sleeps, and wanders across your desktop.
2. **A chatbot** that opens as a speech bubble whenever you click Mochi.

No fluff. No bloated tool pipelines, reminders, or timers. Pure companion vibes.

---

## Quick Start

Requirements: **Node.js 20+** and **npm**.

```bash
npm install
npm start
```

Mochi appears in a transparent, frameless window on your desktop.
- **Click Mochi**: Opens / closes the chatbot.
- **Drag Mochi**: Pick up Mochi (dangles while dragged) and drop anywhere on your screen.
- **Wander**: When left alone, Mochi sits, looks around, and occasionally takes a stroll along your screen.
- **Pet Mochi**: Gently rub your cursor over Mochi's head to make it squint with happy hearts.

### Smoke Test

```bash
npm run smoke
```

Boots the Electron app, verifies window creation and renderer module initialization, and exits cleanly.

### Hotkeys & Tray

| Hotkey | Action |
| --- | --- |
| `Cmd/Ctrl+Shift+M` | Toggle the chatbot |

- **Tray icon**: Right-click Mochi's tray icon to **Show/Hide**, **Reset position (bring Mochi back)**, open **Settings**, or **Quit**.
- **Second launch**: Launching Mochi when it is already running automatically reveals the existing dog window.

---

## Configuration

Settings live in `mochi.config.json` and are editable directly or via the in-app Settings modal:

```json
{
  "provider": "mock",
  "scale": 4,
  "userName": "Friend",
  "wanderEnabled": true,
  "calmMode": false,
  "sleepAfterMinutes": 5,
  "openAtLogin": false
}
```

- **Dog size (scale)**: Integer pixel scaling from 2x (64px) to 6x (192px), crisp pixel-art.
- **My name**: Name Mochi uses when greeting you.
- **Wander**: Toggle screen wandering on/off.
- **Calm mode**: Reduces motion and animations.
- **Connect AI provider**: Currently running offline with friendly companion responses. See `docs/ADD_A_PROVIDER.md` to wire up an external LLM provider.

---

## Project Structure

```
Mochi/
  package.json               # Scripts: start, smoke, build:sprites, dist
  mochi.config.json          # User configuration
  assets/
    sprites/
      spritesheet.png        # 320x320 PNG spritesheet containing 96 frames
      framemap.json          # Animation & effect frame definitions
      palette.json           # ASCII color palette
      frames/*.txt           # Hand-authored ASCII animation frames
  electron/
    main.cjs                 # Transparent window, tray, shortcut, position memory
    preload.cjs              # Minimal context-isolated bridge
  src/
    renderer/
      index.html             # Canvas stage + chat panel + settings modal
      styles.css             # Pixel UI styling, speech-bubble chat UI
      settings.css           # Settings modal styling
      spriteLoader.js        # Loads spritesheet & framemap
      effects.js             # Pixel overlay effects (heart, sparkle, zzz, sweat, dots)
      dog.js                 # Sprite canvas engine (idle life, eye-follow, pet, drag)
      wander.js              # Multi-monitor desktop wandering controller
      panel.js               # Chatbot speech-bubble panel with streaming
      settings.js            # Settings modal controller
      boot.js                # Composition root
    provider/
      interface.js           # AgentProvider interface
      mock.js                # Offline dog companion chatbot
      registry.js            # Provider registry
    state/
      mochiState.js          # Mochi lifecycle states
  scripts/
    smoke.cjs                # Headless smoke test
    build-sprites.cjs        # Sprite sheet compiler
    make-frames.cjs          # Frame authoring utility
  docs/
    ADD_A_PROVIDER.md        # Guide for connecting an external AI provider
    ROADMAP.md               # Future extensions roadmap
```

---

## Privacy & Performance

- **Zero network requests**: Works 100% offline out-of-the-box.
- **Minimal CPU usage**: Timers chained strictly to frame durations, with static sleep mode consuming zero CPU.
- **Respects reduced motion**: Fully honors OS `prefers-reduced-motion` settings.
