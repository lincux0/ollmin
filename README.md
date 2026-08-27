<p align="right">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

<div align="center">
  <h1>Ollmin</h1>
  <img src="assets/ollmin-logo.svg" alt="Ollmin client icon" width="96">
</div>

<p align="center">
  <em>A lightweight Ollama desktop client for low-end devices and small local models.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/release-v1.0.0-2d7d68?style=flat-square" alt="release v1.0.0">
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?style=flat-square&amp;logo=windows&amp;logoColor=white" alt="Windows 10/11">
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&amp;logo=tauri&amp;logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&amp;logo=react&amp;logoColor=20232A" alt="React 19">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript 5">
  <img src="https://img.shields.io/badge/Rust-2021-000000?style=flat-square&amp;logo=rust&amp;logoColor=white" alt="Rust 2021">
  <img src="https://img.shields.io/badge/SQLite-local-003B57?style=flat-square&amp;logo=sqlite&amp;logoColor=white" alt="SQLite local">
  <img src="https://img.shields.io/badge/Ollama-local-111111?style=flat-square" alt="Ollama local">
</p>

Ollmin is not trying to make a chat client more complex. It aims to make a local Ollama conversation feel as close as possible to `ollama run`: avoid unnecessary context, skip unrelated thinking and background requests by default, keep generation to one request, and expose why you are waiting together with real performance metrics.

## What is Ollmin?

Ollmin is a local-first Windows desktop client that connects directly to Ollama running at `127.0.0.1:11434`. It is designed for CPUs, integrated graphics, limited VRAM, or limited system memory, and works well with small models such as Qwen3-4B.

The application does not upload prompts, responses, conversations, or hardware data. It does not provide accounts, cloud APIs, web search, MCP, shell access, file execution, or model tool calls.

## Features

- Local Ollama connection checks, model listing, model warm-up, and keep-alive;
- Native `/api/chat` NDJSON streaming chat;
- Fast, balanced, and reasoning performance modes;
- Fast mode with thinking disabled, a 4K context, `num_predict=2048`, and complete-turn history trimming;
- Separate thinking and answer rendering, stop generation, copy, and automatic scrolling while output grows;
- Basic Markdown rendering for headings, emphasis, strikethrough, lists, blockquotes, and separators;
- SQLite local conversations with search, rename, restore, delete, and Markdown/JSON export;
- Default model and per-model aliases for new conversations;
- Load, prompt, output-token, tok/s, thinking-character, and stop-reason metrics;
- Batched stream events, coalesced frontend updates, debug diagnostics, and a custom borderless title bar.

## Preview

<p align="center">
  <img src="assets/ollmin-ui.png" alt="Ollmin local chat interface" width="1000">
</p>

## Requirements

- Windows 10/11;
- Node.js for frontend development and builds;
- The Rust toolchain and Tauri 2 prerequisites;
- Ollama installed and running;
- At least one local model.

For example:

```powershell
ollama serve
ollama pull qwen3:4b
```

If Ollama uses a different model name, select it from the client's model list.

## Quick start

```powershell
git clone https://github.com/lincux0/ollmin.git
cd ollmin
npm install
npm run tauri -- dev
```

Once the development window opens, choose a model and performance mode on the left, then enter and send a message. The default model in Settings is used for new conversations; saved model aliases are applied immediately to the current interface and later displays.

Running only `npm run dev` or `npm run preview` is useful for checking frontend styles, but a browser does not provide the Tauri `invoke` runtime and cannot replace the desktop client for connecting to Ollama.

## Performance modes

| Mode | Default strategy | Best for |
| --- | --- | --- |
| Fast | `think=false`, 4K context, 2048 output limit, strict complete-turn history trimming | Short questions, translation, rewriting, low-end devices |
| Balanced | `think=true`, 4K context, 768 output limit | Everyday multi-turn conversations |
| Reasoning | `think=true`, 8K context, 2048 output limit | Complex analysis and code troubleshooting |

These are request settings sent to Ollama, not guarantees about the model's raw inference speed. Quantization, processor, memory bandwidth, whether the model is already loaded, and context length all affect the final tok/s.

## How it works

```text
React UI
  │ Tauri invoke / events
  ▼
Rust backend
  ├─ Connects to local Ollama
  ├─ Parses NDJSON and separates thinking/answer content
  ├─ Schedules, cancels, and diagnoses one request at a time
  └─ Reads and writes local SQLite
       │                         │
       ▼                         ▼
127.0.0.1:11434              %APPDATA%\com.ollmin.desktop\ollmin.sqlite3
Ollama /api/*                Local conversations, settings, and exports
```

## Build and test

```powershell
# Frontend
npm run test
npm run build

# Rust
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml

# Desktop application
npm run tauri -- build --debug
npm run tauri -- build
```

Build outputs:

- Debug: `src-tauri/target/debug/ollmin.exe` (console retained for debugging);
- Release: `src-tauri/target/release/ollmin.exe` (Windows console hidden).

The current `tauri.conf.json` does not enable the installer bundle, so the repository's regular build produces executables rather than MSI/NSIS installers.

## Release process

Before a release, make sure the versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` match. Run the tests, frontend build, and Rust checks. After the `main` checks pass in GitHub Actions, the maintainer can create a version tag such as `v1.0.0` and attach release notes plus the Windows Release executable or installer to a GitHub Release.

The installer bundle remains disabled by default. Building an MSI/NSIS installer is a separate release step and must be explicitly enabled and verified; it is not produced by ordinary Debug/Release verification.

## Local data and privacy

- SQLite database: `%APPDATA%\com.ollmin.desktop\ollmin.sqlite3`;
- Conversations, messages, and settings stay on the local machine by default;
- Thinking content is not saved unless enabled in Settings, and only affects newly saved messages;
- Exports are always triggered explicitly by the user;
- No telemetry, account system, cloud synchronization, or background model requests;
- Model output is never executed as HTML, a command, a script, or a tool call.

## FAQ

### Ollama is shown as disconnected

Make sure Ollama is running and check the local endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/version
```

The client only connects to `127.0.0.1:11434`; it does not switch to a remote address automatically.

### Why does the Debug build open a terminal?

The Debug build keeps a console window so Rust logs remain visible during development. The Release build hides the Windows console. The client is not launching an additional terminal tool.

### Why are Balanced and Reasoning slower than Fast?

Balanced and Reasoning allow thinking, while Reasoning also uses a larger context and output budget. Use the load, prompt, and generation metrics in the interface to identify the bottleneck instead of judging by one response's total time alone.

## Contributing and security

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)

## Current status and boundaries

Ollmin is currently at `1.0.0`. The usable chat loop, local conversations, performance modes, frontend pipeline optimizations, and Debug/Release build verification are in place. Full desktop Playwright E2E coverage, installer signing, automatic updates, and cross-device features are not part of the current release.

Issues and improvements around local Ollama, low-end device performance, streaming UX, and local privacy are welcome. New features should first be evaluated for token, memory, permission, and request-count costs.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
