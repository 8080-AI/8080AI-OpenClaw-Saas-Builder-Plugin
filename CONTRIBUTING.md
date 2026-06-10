# Contributing to the 8080.ai OpenClaw Plugin

Thanks for helping improve the 8080.ai OpenClaw plugin. This guide explains how to set up the project, make changes, and check your work before opening a contribution.

## Project Setup

Use Node.js `>=22.19.0`.

Install dependencies:

```bash
npm install
```

Build the plugin:

```bash
npm run build
```

Install or relink the plugin locally:

```bash
./plugin-install.sh
```

## Development Workflow

The main source entrypoint is `index.ts`. Most plugin behavior lives in `src/`, with one module per tool or feature area. The bundled OpenClaw skill guidance is in `skills/ai8080/SKILL.md`.

For local development, you can run:

```bash
npm run dev
```

Before submitting changes, run:

```bash
npm run build
```

This verifies that the TypeScript bundle can be produced at `dist/index.js`.

## Making Changes

- Keep changes focused on one feature, bug fix, or documentation update.
- Follow the existing TypeScript style and module layout.
- Keep user-facing copy clear, concise, and consistent with the README.
- Update `README.md` when commands, configuration, authentication, or plugin behavior changes.
- Update `skills/ai8080/SKILL.md` when natural-language routing behavior changes.
- Do not commit local API keys, secrets, `.env` files, or generated credentials.

## Plugin Manifest and Contracts

If you add, rename, or remove a tool, update all relevant places:

- `openclaw.plugin.json`
- `package.json` under `openclaw.contracts.tools`
- The tool registration code in `index.ts`
- Related documentation in `README.md`
- Skill routing guidance in `skills/ai8080/SKILL.md`, if applicable

## Manual Checks

After changing plugin behavior, manually verify the affected flow in OpenClaw when possible. Useful checks include:

- Login and API key setup
- Credit balance lookup
- Project listing and project selection
- Starting a new 8080.ai project
- Sending a follow-up project message
- Reviewing requirements or project status
- Continuing planning or triggering agents
- Viewing the active project task list

## Pull Request Checklist

Before opening a pull request:

- Run `npm run build`.
- Confirm documentation is updated for user-facing changes.
- Confirm new or changed tools are listed in the manifest and package contracts.
- Confirm no secrets or local-only files are included.
- Describe the change, why it is needed, and how you verified it.

## Support

For questions or support, contact [support@8080.ai](mailto:support@8080.ai).

## License

By contributing, you agree that your contributions will be licensed under the GNU General Public License v2.0 only. See `LICENSE`.
