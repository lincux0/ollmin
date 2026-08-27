<p align="right">
  <a href="SECURITY.md">English</a> | <a href="SECURITY.zh-CN.md">简体中文</a>
</p>

# Security Policy

## Supported versions

We currently support the `main` branch and the latest `1.0.x` release. Ollmin sends requests only to the local Ollama endpoint `127.0.0.1:11434` by default and does not provide accounts, cloud APIs, telemetry, or remote-host configuration.

## Reporting a vulnerability

Please do not publish an unresolved vulnerability, exploit code, conversation content, or sensitive file in a public issue. Prefer **Report a vulnerability** on the repository's Security page when private vulnerability reporting is enabled. If that entry is unavailable, contact the maintainer through a private channel before sharing details.

Please include, where possible:

- The affected version, operating system, and Ollama version;
- Minimal reproducible steps or a PoC with real prompts, paths, and secrets removed;
- Expected behavior, actual behavior, and potential impact;
- Any remediation suggestion you consider useful.

The maintainer will acknowledge the report, assess its impact, and decide on a fix and disclosure timeline. Please allow a reasonable remediation window and do not distribute details to third parties before the issue is addressed.

## Privacy boundary

Conversations and settings are stored in a local SQLite database by default. Before submitting an issue or log, manually remove prompts, model output, usernames, absolute paths, and secrets. The project normally does not need those details to reproduce a problem.
