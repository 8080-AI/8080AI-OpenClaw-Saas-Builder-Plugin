# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An [OpenClaw](https://openclaw.dev) plugin that integrates the [8080.ai](https://8080.ai) AI software development platform. It registers a slash command (`/ai8080`) and five AI tools that the LLM can invoke from natural-language prompts.

## Commands

```bash
# Run the plugin locally (tsx watch for hot-reload during dev)
npm run dev

# Run once
npm start

# Install the plugin into OpenClaw and restart the gateway
./plugin-install.sh
```

The install script removes `~/.openclaw/extensions/8080`, runs `openclaw plugins install ./`, and restarts the gateway.

## Architecture

### Entry point: `index.ts`
Calls `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`. The `register(api)` callback wires together:
1. **Slash command** — `/ai8080` (registered via `api.registerCommand`) — for auth flows and manual operations where the LLM should not be involved.
2. **AI tools** — registered via `api.registerTool`, invoked by the LLM automatically from natural-language prompts.

Config (`siteUrl`, `apiBaseUrl`, `pollingTimeoutMs`) comes from `api.pluginConfig` and is declared in `openclaw.plugin.json`.

### Auth layer: `auth.ts` (and `src/auth.ts`)
Token is stored as JSON at `<stateDir>/plugins/8080/auth.json` (mode 0o600). `requireToken` throws `AuthRequiredError` if no token is present; callers catch this and return a user-facing message. The root `auth.ts` and `src/auth.ts` contain the same auth utilities — the root file exists as a top-level export alias.

### API client: `src/api-client.ts`
Thin `fetch` wrapper. All methods go through `apiFetch`, which attaches `Authorization: Bearer <token>` and throws `AuthError` on 401, `ApiError` on other non-OK responses. Several endpoints are marked `// TODO: verify endpoint` — the actual 8080.ai API shapes are unconfirmed.

### Slash command: `src/command.ts`
Handles: `login` (opens browser), `set-token`, `logout`, `credits`, `status <id>`, `review <id>`, `continue <id>`. Returns `{ text }` objects.

### AI tools (`src/*-tool.ts`)
Each tool factory accepts `{ stateDir, apiBaseUrl, [pollingTimeoutMs] }` and returns an object with `name`, `description`, `parameters` (TypeBox schema), and `execute`.

| Tool name | File | Purpose |
|---|---|---|
| `start_project` | `start-project-tool.ts` | Creates a project, polls every 3 s until `requirements` or `complete`/`failed` phase |
| `get_project_status` | `project-status-tool.ts` | One-shot status fetch |
| `get_credits_balance` | `credits-tool.ts` | Subscription/credits info |
| `open_project_requirements` | `review-project-tool.ts` | Opens requirement doc URL in browser |
| `continue_project` | `continue-project-tool.ts` | Signals 8080.ai to proceed past requirement review |

### A2UI buttons: `src/review-continue.ts`
`buildReviewContinueJsonl` returns JSONL embedded in an HTML comment (`<!-- a2ui ... -->`) inside the tool response text. This is the OpenClaw protocol for rendering interactive buttons. Button values are prefixed `8080_review_<id>` or `8080_continue_<id>` so the LLM can route them back to the correct tool. `parseButtonValue` decodes them.

## Project phases

`planning` → `requirements` (requirement doc available, buttons shown) → `building` → `complete` | `failed`

The `start_project` tool polls until `requirements` (hands off to user) or a terminal phase. Status polling timeout defaults to 10 minutes, configurable via `pollingTimeoutMs` in plugin config.
