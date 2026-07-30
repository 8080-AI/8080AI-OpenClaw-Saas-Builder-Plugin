# [8080.ai](https://8080.ai) OpenClaw Plugin

OpenClaw native-first plugin for creating, managing, reviewing, and building software projects on [8080.ai](https://8080.ai).

The plugin lets an OpenClaw agent authenticate with [8080.ai](https://8080.ai), start new projects from requirements, continue project planning, review generated artifacts, inspect task lists, and trigger build-related actions.

## Runtime Requirements

- Required runtime: Node.js `>=22.19.0`
- Required env vars: none
- Network targets:
  - `https://8080.ai/`
  - `https://api.8080.ai/api/v1`

## What It Ships

- Package name: `8080ai`
- Plugin id: `8080ai`
- Native manifest: `openclaw.plugin.json`
- Native entrypoint: `dist/index.js`
- Source entrypoint: `index.ts`
- Embedded skill: `skills/ai8080/SKILL.md`
- Format: native OpenClaw plugin with bundled skill guidance
- License: GNU General Public License v2.0 only

## Capabilities

- Start a new [8080.ai](https://8080.ai) project from an OpenClaw prompt.
- List and select existing [8080.ai](https://8080.ai) projects.
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

## Authentication

Use the login command:

```text
/ai8080 login
```

Or ask naturally using any similar wording (applies to all commands):

- login to [8080.ai](https://8080.ai)
- sign in to [8080.ai](https://8080.ai)
- log in using [8080.ai](https://8080.ai)
- connect me to [8080.ai](https://8080.ai)

Generate an OpenClaw API key:

1. Go to [8080.ai](https://8080.ai) and sign in to your account.
2. Open your **Profile** page.
3. Navigate to **OpenClaw Secret Key Generation**.
4. Click **Generate Secret Key**.
5. Enter a name for the key (optional) and select an expiration period:
   - Never Expires
   - 15 Days
   - 30 Days
   - 90 Days
6. Click **Create Secret Key**.
7. Copy the generated secret key immediately. For security reasons, the key is displayed only once.
8. Click **Done**.

Save the key in OpenClaw:

Run the following command in OpenClaw, replacing `<api-key>` with the key you copied:

```text
set api-key <api-key>
```

The API key is decoded locally from Base64 URL-safe JSON and validated before saving. If the key contains `exp`, the plugin checks `ts + exp` and rejects expired keys. On 8080.ai, API keys can be created for 15 days, 30 days, 90 days, or never expire. If `exp` is omitted, the key does not expire locally.

API keys are stored locally in OpenClaw state under `plugins/8080/api-key.json`, with file permissions managed by the host environment.
Expired keys:

If your API key expires:

1. Go to **OpenClaw Secret Key Generation** in your 8080.ai **Profile**.
2. Delete the expired key.
3. Generate a new key by following the steps in **Generate an OpenClaw API key** above.
4. Save the new key by following the steps in **Save the key in OpenClaw** above.

## Security & Privacy

- This plugin communicates only with the configured 8080.ai endpoints.
- Default network targets are `https://8080.ai/` and `https://api.8080.ai/api/v1`.
- API keys are handled only by `ai8080_login` and `/ai8080 set api-key`.
- API keys are validated locally before saving and are stored in local OpenClaw plugin state.
- The plugin does not log full API keys, authorization headers, or credential payloads.
- The plugin does not execute shell commands, spawn processes, or read arbitrary workspace files.
- Project requirements and follow-up messages are sent to 8080.ai only when the user starts or updates a project.

## Audit Notes

The published package contains only the built OpenClaw entrypoint, native manifest, bundled skill, README, package metadata, and license. It does not include `.env` files, local development scripts, source tests, generated SkillHub artifacts, or bundled credentials. Credential handling is limited to local OpenClaw plugin state and outbound requests to the configured 8080.ai API endpoint.

## Commands

| Slash command | Natural-language option |
| --- | --- |
| `/ai8080 login` | login to [8080.ai](https://8080.ai) |
| `/ai8080 set api-key <api-key>` | `set my 8080 api key to <api-key>` |
| `/ai8080 credits` | check my [8080.ai](https://8080.ai) credits |
| `/ai8080 list` | list my [8080.ai](https://8080.ai) projects |
| `/ai8080 select <number>` | `select project <number>` |
| `/ai8080 start <requirements>` | start an [8080.ai](https://8080.ai) project for `<requirements>` |
| `/ai8080 message <text>` | send this message to my [8080.ai](https://8080.ai) project: `<text>` |
| `/ai8080 task-list` | show the task list for my [8080.ai](https://8080.ai) project |
| `/ai8080 select-button <number>` | `choose option <number>` |

## Natural-Language Agent Requests

These requests are handled through the registered OpenClaw tools:

| Request | Tool |
| --- | --- |
| check the status of my [8080.ai](https://8080.ai) project | `ai8080_get_project_status` |
| review my [8080.ai](https://8080.ai) project requirements | `ai8080_open_project_requirements` |
| continue my [8080.ai](https://8080.ai) project | `ai8080_continue_project` |
| run the [8080.ai](https://8080.ai) planning agents | `ai8080_trigger_agents` |
| `start building this project` | `ai8080_select_button` or `ai8080_send_message` |

## Registered Tools

| Tool | Purpose |
| --- | --- |
| `ai8080_login` | Opens login guidance and securely saves a validated OpenClaw API key. |
| `ai8080_start_project` | Starts a new [8080.ai](https://8080.ai) project from the user's requirements. |
| `ai8080_send_message` | Sends follow-up instructions or changes to the active project. |
| `ai8080_get_credits_balance` | Checks the user's current plan and available credits. |
| `ai8080_get_project_status` | Shows status, progress, and current phase for a project. |
| `ai8080_open_project_requirements` | Opens or reviews the generated requirements document for a project. |
| `ai8080_continue_project` | Resumes planning or building after a review checkpoint. |
| `ai8080_trigger_agents` | Runs selected planning or build agents for a project. |
| `ai8080_list_projects` | Lists available projects and shows project-selection UI. |
| `ai8080_select_project` | Sets an existing project as the active project for the session. |
| `ai8080_select_button` | Resolves numbered suggested actions such as Continue, Review, or Start Building. |
| `ai8080_task_list` | Fetches and summarizes the task list for the active project. |

## Notes

- OpenClaw loads the native manifest from `openclaw.plugin.json`.
- The bundled skill at `skills/ai8080/SKILL.md` provides routing guidance for natural-language requests.
## Support

For support, contact [support@8080.ai](mailto:support@8080.ai).
## License

GNU General Public License v2.0 only. See `LICENSE`.
