# Changelog

All notable changes to this project are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a structured JSONL logger shared by OpenCode, CodeBuddy, and Claude Code proxies, with request IDs, sanitized request/upstream summaries, durations, upstream error previews, and Claude Code tool parsing diagnostics.
- Added `claudecode/tool-parser.js`, a dedicated Claude Code tool-call parsing and repair pipeline inspired by `ds-free-api` design ideas without copying GPL code.
- Added parser-only regression tests in `scripts/test-tool-parser.js` for malformed Claude Code tool-call outputs.

### Changed

- Refactored Claude Code tool parsing out of the proxy into a candidate extraction, repair, whitelist, and required-field validation pipeline.
- Improved Claude Code streaming `tool_use` output to send tool inputs through Anthropic-style `input_json_delta` events, fixing empty `Bash IN` blocks and missing `command` errors.
- Expanded Claude Code parser coverage for malformed `<tool_call>` blocks, `</think>` truncation, DeepSeek-style tool tags, JSON arrays, code-fence false positives, Windows paths, and malformed `<arg_key>` key/value pairs.
- Improved runtime troubleshooting documentation for SZTU upstream 502s, Claude Code tool parsing, and stream tool input handling.

### Fixed

- Fixed Claude Code stream tool calls where the parser found `command` but Claude Code did not receive it because the proxy placed input only on `content_block_start`.
- Fixed malformed Bash tool-call parsing for outputs such as `<arg_key>command": "git diff"</arg_value>`.
- Fixed noisy logs that could not reliably distinguish local port conflicts, upstream APISIX errors, parser misses, and tool bridge failures.

## [0.1.0] - 2026-05-19

### Added

- Initial release of SZTU API local compatibility proxy
- **OpenCode proxy (:8788)**: OpenAI-compatible endpoint with model name normalization, `max_tokens` clamping, and `chat_template_kwargs` injection
- **Claude Code proxy (:8790)**: Anthropic Messages API translation with SSE remapping, prompt-level tool call bridging, and 5xx retry
- **CodeBuddy proxy (:8787)**: `chat/completions` passthrough with `/v1/responses` format conversion
- Shared environment variable loader, API key management, and `max_tokens` limits (default 16384, max 32768)
- Comprehensive test suite covering streaming/non-streaming, GLM/DeepSeek, and tool calls across all proxies
- Documentation: API references, implementation notes, and test matrix
