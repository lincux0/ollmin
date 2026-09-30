<p align="right">
  <a href="CHANGELOG.md">English</a> | <a href="CHANGELOG.zh-CN.md">简体中文</a>
</p>

# Changelog

## 1.2.0 — 2026-09-30

### Changed

- Rebuilt the desktop chat layout with neutral light/dark themes, a compact title bar, resizable sidebar and shared reading/composer width.
- Added title-bar session search, keyboard menus, a persistent composer, model/performance selection and clearer attachment states.
- Improved reading anchors, user-turn navigation, thinking disclosure and separate message/thinking/code copy controls.
- Reorganized settings into four sections with theme/font previews, cancel restoration and recoverable save errors.
- Refined spacing, rounded controls and alias-only model labels while retaining real model identifiers for requests.

### Validation and limits

- Local frontend tests and browser fixture checks passed; the Windows NSIS installer is provided separately.
- Ollama remains fixed to the local endpoint. No accounts, telemetry, extra background model requests or database migration were added.
- Installer signing and automatic updates are not included. Native IME, the full Windows DPI matrix and complete native chat end-to-end coverage remain pending; rich text remains the existing safe subset.

## 1.1.1 — 2026-09-29

### Changed

- Refined the chat layout, compacted composer controls, and simplified user messages;
- Moved the assistant copy control beside the model label and reduced the on-screen metrics to a brief speed/time summary.

### Fixed

- Preserved attachment-cache entries when persistence fails and avoided re-locking the cache during release;
- Kept Ollama traffic on the local endpoint by bypassing proxies and refusing redirects.

## 1.1.0 — 2026-08-29

### Changed

- File attachments now appear on the sent user message instead of remaining above the composer;
- Attachment metadata is persisted with its message and restored when a local conversation is reopened;
- Later messages no longer resend attachments selected for an earlier message automatically;
- Added the Windows NSIS setup package for this release.

## 1.0.0 — 2026-08-27

First stable release. It provides a Windows Release executable and a separately generated NSIS installer workflow. The feature set and privacy boundary continue from 0.2.0; see the historical notes below.

## 0.2.0 — 2026-08-27

### Added

- A complete local Ollama chat loop for the Windows desktop client;
- SQLite local conversations with search, rename, delete, and Markdown/JSON export;
- Per-model aliases with immediate display in the current interface;
- Configurable 4K, 8K, and 16K context sizes;
- Fast, Balanced, and Reasoning performance modes;
- Separate thinking/answer rendering, stop generation, copy, and basic Markdown rendering;
- Coalesced stream events, performance metrics, and debug diagnostics;
- A custom borderless window bar and Windows Debug/Release build entry points.

### Privacy and boundaries

- Ollama is fixed to the local endpoint `127.0.0.1:11434`;
- No accounts, cloud synchronization, telemetry, web search, shell, file execution, MCP, or model tool calls;
- Thinking content is not written to the local database by default.

### Known limitations

- Only Windows 10/11 has been validated;
- There is no complete desktop Playwright E2E workflow;
- The Tauri installer bundle is disabled for ordinary builds; releases mainly provide source code and Debug/Release executables;
- Installer signing and automatic updates are not provided.
