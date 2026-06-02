# 8080.ai OpenClaw Plugin

OpenClaw native-first plugin for creating, managing, reviewing, and building software projects on 8080.ai.

The plugin lets an OpenClaw agent authenticate with 8080.ai, start new projects from requirements, continue project planning, review generated artifacts, inspect task lists, and trigger build-related actions.

## Runtime Requirements

- Required runtime: Node.js `>=22.19.0`
- Required env vars: none
- Optional env template: `.env.example`
- Network targets:
  - `https://8080.ai/`
  - `https://api.8080.ai/api/v1`

## What It Ships

- Package name: `ai8080`
- Plugin id: `ai8080`
- Native manifest: `openclaw.plugin.json`
- Native entrypoint: `dist/index.js`
- Source entrypoint: `index.ts`
- Embedded skill: `skills/ai8080/SKILL.md`
- Format: native OpenClaw plugin with bundled skill guidance
- License: GNU General Public License v2.0 only

## Capabilities

- Start a new 8080.ai project from an OpenClaw prompt.
- List and select existing 8080.ai projects.
- Review requirements, design, architecture, and task checkpoints.
- Continue planning agents and start building when the project is ready.
- Send follow-up project messages and implementation requests.
- Check credits, project status, and task lists.
- Use slash commands or natural-language requests.

## Installation

Install dependencies:

```bash
npm install
```

Build the plugin bundle:

```bash
npm run build
```

Install or relink the plugin locally:

```bash
./plugin-install.sh
```

After installation, restart OpenClaw if your environment does not restart the gateway automatically.

For a full local developer setup guide, see `LOCAL_DEVELOPMENT.md`.

## Configuration

The plugin defaults to:

| Field | Default |
| --- | --- |
| `siteUrl` | `https://8080.ai/` |
| `apiBaseUrl` | `https://api.8080.ai/api/v1` |

You can override these values from OpenClaw plugin config:

```json
{
  "siteUrl": "https://8080.ai/",
  "apiBaseUrl": "https://api.8080.ai/api/v1"
}
```

If your OpenClaw setup supports env-based config substitution, `.env.example` is included as an optional template. Creating a `.env` file is not required for normal installation.

## Authentication

Use the login command:

```text
/ai8080 login
```

Or ask naturally:

```text
login to 8080.ai
```

Then save your 8080.ai auth token:

```text
/ai8080 set-token <auth_token>
```

For automatic session renewal, save both access and refresh tokens:

```text
/ai8080 set-tokens <auth_token> <refresh_token>
```

Tokens are stored locally in OpenClaw state under `plugins/8080/auth.json` with file permissions managed by the host environment.

## Commands

| Slash command | Natural-language option |
| --- | --- |
| `/ai8080 login` | `login to 8080.ai` |
| `/ai8080 credits` | `check my 8080.ai credits` |
| `/ai8080 list` | `list my 8080.ai projects` |
| `/ai8080 select <number>` | `select project <number>` |
| `/ai8080 start <requirements>` | `start an 8080.ai project for <requirements>` |
| `/ai8080 message <text>` | `send this message to my 8080.ai project: <text>` |
| `/ai8080 task-list` | `show the task list for my 8080.ai project` |
| `/ai8080 select-button <number>` | `choose option <number>` |

## Natural-Language Agent Requests

These requests are handled through the registered OpenClaw tools:

| Request | Tool |
| --- | --- |
| `check the status of my 8080.ai project` | `ai8080_get_project_status` |
| `review my 8080.ai project requirements` | `ai8080_open_project_requirements` |
| `continue my 8080.ai project` | `ai8080_continue_project` |
| `run the 8080.ai planning agents` | `ai8080_trigger_agents` |
| `start building this project` | `ai8080_select_button` or `ai8080_send_message` |

## Registered Tools

- `ai8080_login`
- `ai8080_start_project`
- `ai8080_send_message`
- `ai8080_get_credits_balance`
- `ai8080_get_project_status`
- `ai8080_open_project_requirements`
- `ai8080_continue_project`
- `ai8080_trigger_agents`
- `ai8080_list_projects`
- `ai8080_select_project`
- `ai8080_select_button`
- `ai8080_task_list`

## Notes

- OpenClaw loads the native manifest from `openclaw.plugin.json`.
- The bundled skill at `skills/ai8080/SKILL.md` provides routing guidance for natural-language requests.
- The plugin does not require users to create a `.env` file.
- Authenticated 8080.ai API requests send the saved token as an HTTP Bearer token.
- Plugin logs are temporarily enabled for testing in this branch.

## License

GNU General Public License v2.0 only. See `LICENSE`.
