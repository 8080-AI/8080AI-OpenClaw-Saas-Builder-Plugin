# 8080.ai OpenClaw Plugin

Use 8080.ai from OpenClaw to create projects, review generated planning artifacts, continue project planning, inspect tasks, and start the build phase.

## Features

- Start a new 8080.ai project from an OpenClaw prompt.
- List and select existing 8080.ai projects.
- Review project requirements, design, architecture, and task checkpoints.
- Continue planning agents and start building when the project is ready.
- Check credits, project status, tasks, and model settings.

## Installation

Install the published package with OpenClaw:

```bash
openclaw plugins install npm:ai8080
```

For local development:

```bash
npm install
npm run build
openclaw plugins install /path/to/mostlyagent2-openclaw-plugin --force
```

## Configuration

The plugin defaults to:

- Website: `https://8080.ai/`
- API: `https://api.8080.ai/api/v1`

Optional environment variables for local development are documented in `.env.example`.

OpenClaw can load these values from the current shell environment, a local `.env`, `~/.openclaw/.env`, or config variable substitution:

```bash
AI8080_SITE_URL=https://8080.ai/
AI8080_API_BASE_URL=https://api.8080.ai/api/v1
```

You can also reference them from OpenClaw plugin config:

```json
{
  "siteUrl": "${AI8080_SITE_URL}",
  "apiBaseUrl": "${AI8080_API_BASE_URL}"
}
```

## Authentication

Use:

```text
/ai8080 login
```

Then follow the instructions to save your 8080.ai auth token:

```text
/ai8080 set-token <auth_token>
```

For automatic session renewal:

```text
/ai8080 set-tokens <auth_token> <refresh_token>
```

Tokens are stored locally in OpenClaw state under `plugins/8080/auth.json` with file permissions set by the host environment.

## Commands

```text
/ai8080 login
/ai8080 credits
/ai8080 list
/ai8080 select <number>
/ai8080 start <requirements>
/ai8080 message <text>
/ai8080 task-list
/ai8080 model
/ai8080 select-button <number>
```

## Privacy

Authenticated 8080.ai API requests send the saved token as an HTTP Bearer token. Plugin logs are disabled by default. Set `AI8080_DEBUG=1` only for local debugging.
