<p align="right">
  <a href="CONTRIBUTING.md">English</a> | <a href="CONTRIBUTING.zh-CN.md">简体中文</a>
</p>

# Contributing to Ollmin

Thank you for your interest in Ollmin. Ollmin is a lightweight Ollama client for Windows low-end devices and small local models. Contributions should preserve that focus: fewer requests, low resource use, explainable waiting states, and a clear local privacy boundary.

## Development environment

- Windows 10/11;
- Node.js 20 or newer;
- The Rust stable toolchain and Tauri 2 prerequisites;
- Ollama running at the default address `127.0.0.1:11434`.

```powershell
npm ci
npm run tauri -- dev
```

## Checks before submitting

Run the following commands from the repository root:

```powershell
npm run test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

Real Ollama tests may use models installed on your machine, but a particular model response or tok/s value must not be used as a stable unit-test assertion. The project does not currently have a complete desktop Playwright E2E workflow; describe manual window checks in the pull request when they matter.

## Scope of changes

- Keep Ollama requests in the Rust backend and, by default, connect only to `127.0.0.1:11434`;
- Do not add telemetry, accounts, cloud synchronization, web search, shell access, file execution, MCP, or model tool calls;
- Never treat model output as HTML, a script, or a command;
- When changing performance modes, stream events, history trimming, or the SQLite schema, add or update frontend and backend tests;
- Thinking content is not persisted by default unless the user explicitly enables the setting;
- Do not commit `node_modules`, build artifacts, databases, environment files, Graphify caches, or internal maintenance documents.

## Pull request guidance

1. Keep one pull request focused on one issue or small feature. Explain the motivation, scope, and checks you ran.
2. Include a screenshot or window-size notes for UI changes. Include comparable data using the same model, prompt, and context settings for performance changes.
3. Do not paste real conversations, personal paths, secrets, or complete model outputs into a pull request.
4. When CI fails, distinguish code failures from local Ollama or build-environment problems before submitting reproducible details.
