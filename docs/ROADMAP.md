# Mochi Roadmap 🗺️

This document outlines the architectural plan for future capabilities while preserving Mochi's minimalist companion core.

---

## Architecture Principles

1. **Keep the Core Pure**: The desktop dog and chat interface remain lightweight, distraction-free, and responsive.
2. **Provider Pluggability**: External intelligence plugs in exclusively via the `AgentProvider` boundary (`src/provider/interface.js`).
3. **No Unwanted Background Watchers**: Background services (file system watchers, git polling) are opt-in plugins rather than core dependencies.

---

## Potential Future Integrations

### 1. Real AI Providers
- **Anthropic Claude / OpenAI / Local Ollama**:
  - Implement streaming providers following `docs/ADD_A_PROVIDER.md`.
  - Settings UI toggle to switch between offline Mock and connected LLMs.
  - Safe credential storage via OS keychain (`keytar` or system credential manager).

### 2. GitHub Integration (Opt-in)
- **Use case**: Ask Mochi about your assigned PRs, review comments, or CI status.
- **Implementation**:
  - Encapsulated provider plugin that authenticates via GitHub Personal Access Token or OAuth device flow.
  - Read-only queries by default with explicit user prompt confirmation for actions.

### 3. Shopify / E-Commerce Integration (Opt-in)
- **Use case**: Query store orders, inventory alerts, or daily revenue summaries.
- **Implementation**:
  - Standalone plugin connecting to Shopify Admin GraphQL API.
  - Custom canned dog reactions (e.g. happy bounce on new store orders).

### 4. Interactive Personality & Voice
- Optional WebSpeech API / offline TTS for spoken dog bark sounds or short greetings.
- Seasonal outfits or accessory SVG layers (e.g. hats, collars) toggled via settings.
