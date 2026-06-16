# Contributing to the 8080.ai OpenClaw Plugin

Thanks for helping improve the 8080.ai OpenClaw plugin. This project connects OpenClaw to the 8080.ai software development platform, so contributions should preserve both the OpenClaw plugin contract and the 8080.ai project workflow.

## Requirements

- Node.js `>=22.19.0`
- npm
- OpenClaw, for local plugin installation and manual verification
- An 8080.ai account and OpenClaw API key when testing authenticated flows

## Repository Overview

Important files and directories:

| Path | Purpose |
| --- | --- |
| `index.ts` | Native OpenClaw plugin entrypoint. Registers the slash command and all AI tools. |
| `src/command.ts` | Implements the `/ai8080` slash command fallback. |
| `src/*-tool.ts` | Individual OpenClaw AI tool implementations. |
| `src/api-client.ts` | 8080.ai API client, streaming, auth errors, project status types, and agent helpers. |
| `src/*-state.ts` | Local OpenClaw state helpers for active projects, models, and suggestions. |
| `skills/ai8080/SKILL.md` | Natural-language routing guidance for OpenClaw agents. |
| `openclaw.plugin.json` | Native OpenClaw manifest and plugin config schema. |
| `package.json` | npm metadata, scripts, dependencies, and OpenClaw tool contracts. |
| `plugin-install.sh` | Local development install script for relinking the plugin into OpenClaw. |
| `README.md` | User-facing installation, authentication, command, and tool documentation. |

## Git Workflow & Branch Naming Convention

We follow a **branch-per-change** workflow. Every contribution—whether it is a new feature, a bug fix, a refactor, a changes or a docs update—must live on its own branch created from `develop`.

### Branch Name Format

```
<type>/<short-description>
```

- **`type`** — a category prefix (see table below).
- **`short-description`** — a lowercase, hyphen-separated summary of the change (`kebab-case`).

### Branch Type Prefixes

| Prefix | When to use | Examples |
| --- | --- | --- |
| `feature/` | New functionality or capability | `feature/show-start-building`, `feature/start-building`, `feature/show-project-history` |
| `fix/` | Bug fixes and stability updates | `fix/login-error`, `fix/project-status`, `fix/streaming-response` |
| `refactor/` | Code restructuring or cleanup that does not change behavior | `refactor/remove-commands`, `refactor/api-client`, `refactor/remove-extras` |
| `docs/` | Documentation-only changes | `docs/add-contributing-guide` |
| `changes/` | Small, miscellaneous updates (config tweaks, naming, metadata) | `changes/plugin-name`, `changes/plugin-documentation-updates` |

> **Note:** Always create change branches from `develop`, not from `main`.

### Protected Branches

| Branch | Purpose |
| --- | --- |
| `main` | Production-ready, stable code. **Never push directly to `main`.** All changes reach `main` through pull requests only. |
| `develop` | Active development integration branch. Create all `fix/`, `changes/`, `feature/`, `docs/`, and `refactor/` branches from `develop`; merge reviewed work back into `develop` before promotion to `main`. |

### Step-by-Step: Creating a Branch & Opening a PR

1. **Make sure you're on `develop` and it's up to date:**

   ```bash
   git checkout develop
   git pull origin develop
   ```

2. **Create your branch using the naming convention:**

   ```bash
   # New feature
   git checkout -b feature/your-feature-name

   # Bug fix
   git checkout -b fix/describe-the-fix

   # Refactor
   git checkout -b refactor/describe-the-change

   # Documentation update
   git checkout -b docs/what-you-are-documenting

   # Small miscellaneous change
   git checkout -b changes/what-changed
   ```

3. **Make your changes, then stage and commit:**

   ```bash
   git add .
   git commit -m "short description of what changed"
   ```

   Write clear, concise commit messages. Examples:
   - `added ci/cd pipeline and updated package.json`
   - `implemented natural language routing for tools`
   - `removed unused commands`
   - `updated contribution guide with branch conventions`

4. **Push the branch to the remote:**

   ```bash
   git push origin feature/your-feature-name
   ```

5. **Open a Pull Request (PR) on GitHub** targeting `develop`. In the PR description:
   - Explain **what** changed.
   - Explain **why** it changed.
   - Explain **how** it was verified.

6. **Wait for review.** Do not merge your own PR unless you have explicit approval.

### Quick Reference

```text
main                              ← stable, production-ready
 └── develop                      ← active development integration
     ├── feature/start-buidling         ← for showing start building button
     ├── feature/show-project-history          ← for showing previous latest chat message of selected project
     ├── fix/resolve-bugs         ← bug fixes and stability
     ├── refactor/remove-commands ← cleaning up unused code
     ├── docs/add-contributing-guide
     └── changes/plugin-name      ← renaming the plugin
```

## Setup

Install dependencies:

```bash
npm install
```

Build the plugin bundle:

```bash
npm run build
```

For local development with TypeScript execution:

```bash
npm run dev
```

Install or relink the plugin locally:

```bash
./plugin-install.sh
```

The install script uninstalls any existing `8080ai` plugin, installs this checkout with `--link`, and restarts the OpenClaw gateway.

## Development Guidelines

- Keep each change focused on one feature, fix, refactor, change, or documentation update.
- Follow the existing TypeScript module style and keep tool-specific logic in the relevant `src/*-tool.ts` file.
- Keep shared API behavior in `src/api-client.ts` and shared state behavior in the appropriate `src/*-state.ts` helper.
- Preserve authenticated flow safety. API keys should only be handled through the existing login/API-key helpers.
- Do not log API keys, secrets, full credentials, or sensitive user data.
- Keep user-facing tool responses consistent with the README and skill guidance.
- Avoid changing the raw user prompt before sending it to 8080.ai. The start-project flow intentionally passes the user's requirements as-is.

## Adding or Changing Tools

When adding, renaming, or removing an OpenClaw tool, update every related contract and routing surface:

- Register the tool in `index.ts`.
- Add or update the implementation in `src/`.
- Update `openclaw.plugin.json` under `contracts.tools`.
- Update `package.json` under `openclaw.contracts.tools`.
- Update `README.md` command/tool documentation.
- Update `skills/ai8080/SKILL.md` if natural-language routing changes.

The tool names in the manifest, package contract, and registered implementation must stay in sync.

## Configuration Changes

Plugin config is defined in `openclaw.plugin.json` and read in `index.ts`.

If you add or change config:

- Update `openclaw.plugin.json` under `configSchema`.
- Update the `PluginConfig` type in `index.ts`.
- Provide safe defaults when possible.
- Document the setting in `README.md`.

Current config includes:

- `siteUrl`
- `apiBaseUrl`
- `pollingTimeoutMs`

## Build and Verification

Run this before opening a pull request:

```bash
npm run build
```
   
There is currently no dedicated test script in `package.json`, so manual verification matters for behavior changes.

Recommended manual checks, depending on what changed:

- `/ai8080 login`
- `/ai8080 set api-key <api-key>`
- `/ai8080 credits`
- `/ai8080 list`
- `/ai8080 select <number>`
- `/ai8080 start <requirements>`
- `/ai8080 message <text>`
- `/ai8080 task-list`
- `/ai8080 select-button <number>`
- Natural-language project requests routed through `skills/ai8080/SKILL.md`
- Project review, continue, trigger agents, and status flows

For changes involving streaming or suggested next actions, verify that OpenClaw UI updates still display correctly and that silent responses remain silent when expected.

## Documentation Checklist

Update documentation when behavior changes:

- `README.md` for users
- `skills/ai8080/SKILL.md` for agent routing
- `.github/CONTRIBUTION.md` for contributor workflow changes
- `.env.example` only if environment-based configuration changes

## Pull Request Checklist

Before submitting:

- [ ] Branch is named following the convention: `<type>/<short-description>`
- [ ] Branch is created from an up-to-date `develop`
- [ ] Run `npm run build` — no errors
- [ ] Relevant manual OpenClaw flows were checked
- [ ] Tool contracts are synchronized across `index.ts`, `openclaw.plugin.json`, and `package.json`
- [ ] Docs are updated for user-facing changes
- [ ] No API keys, tokens, `.env` files, or local credentials are included
- [ ] PR description explains what changed, why, and how it was verified

## Support

For support, contact [support@8080.ai](mailto:support@8080.ai).

## License

By contributing, you agree that your contributions will be licensed under the GNU General Public License v2.0 only. See `LICENSE`.
