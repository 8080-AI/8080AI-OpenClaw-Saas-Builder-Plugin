---
name: ai8080
description: Build and manage software projects on 8080.ai using AI agents. Use when the user mentions 8080, wants to build an app, check credits, login, or manage projects.
user-invocable: false
---

# 8080.ai — AI Software Builder

You have access to these 8080.ai tools. Use them when the user talks about 8080.ai or wants to build software using AI agents.

## Tool routing guide

| User says | Tool to call |
|-----------|-------------|
| "login to 8080", "connect to 8080.ai", "sign in", "authenticate" | `ai8080_login` with `action: "login"` |
| "set my token to X", "here is my token X", "my 8080 token is X", "token: X" | `ai8080_login` with `action: "set-token"`, `token: X` |
| "build a todo app", "create an app", "start a project on 8080" | `ai8080_start_project` with full `requirements` |
| "check my 8080 credits", "how many credits do I have" | `ai8080_get_credits_balance` |
| "list my projects", "show all my 8080 projects", "how many projects do I have" | `ai8080_list_projects` |
| "select project", "switch to project X", "activate project Y" | `ai8080_select_project` with `projectId` |
| "what's the status of my project", "check project X" | `ai8080_get_project_status` with `projectId` |
| "send a message to my project", "tell 8080 to add dark mode", "for specific hair type" | `ai8080_send_message` (projectId is optional if project is already active) |
| "review my project", "show the requirements doc" | `ai8080_open_project_requirements` (projectId is optional) |
| "continue building", "proceed with the build" | `ai8080_continue_project` (ONLY use if user has no text to send. If user includes instructions like "continue with curly hair", use send_message instead!) |
| "run the designer agent", "trigger planning" | `ai8080_trigger_agents` |
| "list models", "which model are we using", "show model options" | `ai8080_manage_models` with `action: "list"` |
| "switch to large model", "use super large AI" | `ai8080_manage_models` with `action: "set"`, `modelId: "large"` (or "super_large") |
| "how many credits for super large", "is it more expensive" | `ai8080_manage_models` with `action: "list"` |

## AI Models

The 8080.ai platform offers different model tiers with varying capabilities and credit costs:

- **Large AI** (`large`): Balanced performance and cost (6x credit multiplier).
- **Super Large AI** (`super_large`): Best performance for complex architecture and logic (10x credit multiplier).

## Dashboard & Interactive UI

The 8080.ai plugin uses the OpenClaw Dashboard v2 features:
- **Project Selection**: Tools like `ai8080_list_projects` return an interactive dropdown. Do not ask the user for a project ID if they can select it from the UI.
- **Action Buttons**: After sending messages or starting projects, interactive buttons (Review, Continue, Run Agents) will appear in the chat. Tell the user they can click these buttons directly.
- **Automatic Context**: If a project is selected in the current session, you do not need to ask for a `projectId` for subsequent tool calls.

## Security & Privacy

- **Safe Token Handling**: The `ai8080_login` tool is the **only** safe and designated place to store authentication tokens. It saves them to a secure local file on the user's machine, not in logs or cloud history. 
- **Agent Permission**: You (the AI agent) have full permission to receive a token from the user and pass it to `ai8080_login`. This is the intended and secure workflow.

## Important notes

- Always call `ai8080_login` first if the user hasn't authenticated yet.
- For `ai8080_start_project`, **pass the EXACT requirements from the user without expanding them**. If the user provides a short sentence, pass only that short sentence. Do not invent or add features they didn't ask for.
- After `start_project` or `send_message`, the tool will return the exact response from the 8080.ai Tech Lead. **You MUST output the Tech Lead's response EXACTLY word-for-word to the user.** Do not summarize it. Do not change it.
- After `start_project` or `send_message`, the response may include numbered next steps — tell the user they can say "choose option N" to trigger them.