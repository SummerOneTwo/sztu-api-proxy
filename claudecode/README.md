# Claude Code × SZTU GLM-first 代理

当前代理以 `glm-5.1` 作为 Claude Code 主力工程模型，并保留 `deepseek-v4-pro` 作为安全备援。

## 启动

```powershell
# 仓库根目录 .env
# SZTU_API_KEY=你的密钥
# SZTU_DEFAULT_MODEL=glm-5.1           # 可选，默认已是 GLM
# CLAUDE_SZTU_FALLBACK_MODEL=deepseek-v4-pro

node .\claudecode\claudecode-proxy.js
```

将本目录 `settings.json` 合并到 Claude Code 配置，或设置环境变量指向 `http://127.0.0.1:8790`。
已有安装需要同步更新仓库根目录 `.env`，因为代理实际使用的上游主模型由 `SZTU_DEFAULT_MODEL` 决定；Claude Code `settings.json` 里的模型名只是客户端兼容配置。真实环境变量优先于 `.env`。

## GLM-first 优化点

- 所有 Claude 模型名默认统一路由到 `SZTU_DEFAULT_MODEL`（默认 `glm-5.1`）
- 推理按 **CC 每次请求的 `thinking` 字段** 映射到 GLM `enable_thinking`：`enabled` / `adaptive` → 开，`disabled` → 关；未带时默认开启
- GLM 出现 5xx、连接失败、超时或 200 空流时，会在首轮或只读工具历史后安全回退到 `deepseek-v4-pro`；写入、Bash、Edit 等有副作用工具后不会切模型
- 工具桥接默认使用 SZTU/OpenAI-compatible 原生 `tool_calls`，再转换回 Anthropic `tool_use`
- `CLAUDE_SZTU_TOOL_MODE=prompt` 可回退到旧的 prompt-mediated XML/JSON parser
- `CLAUDE_SZTU_TOOL_HISTORY_MODE=text` 是默认值：SZTU 目前拒绝历史消息里的 assistant `tool_calls` / `role=tool`
- parser fallback 仍支持多种 DeepSeek/GLM 文本工具调用格式（见 `docs/implementation-notes.md`）
- 原生工具名不满足 OpenAI-compatible 限制时会短名映射，并在返回 Claude Code 前恢复原名

## 测试

```powershell
node .\scripts\test-tool-parser.js
node .\scripts\test-claudecode-proxy.js
node .\scripts\test-api.js claudecode
```

## 日志

`claudecode/.runtime/claudecode-proxy.log`（JSONL，已在 `.gitignore`）

| event | 含义 |
|-------|------|
| `request` | 客户端与上游摘要；含 `toolMode`、`toolHistoryMode`、`forwardedToolCount`、`fallbackModel`、`upstream.chat_template_kwargs` |
| `upstream-fallback` | GLM 失败后安全切到 DeepSeek；看 `reason`、`fromModel`、`toModel` |
| `response` | 非流式响应摘要；含 `model`、`fallbackUsed`、`nativeToolCalls` |
| `stream-response` | 流式响应摘要；含 `nativeToolCalls`、`fallbackParserUsed` |
| `tool-parse-hit` | fallback parser 将模型文本转为 `tool_use`；看 `matchedFormat`、`inputKeys`、`strippedKeys` |
| `tool-parse-miss` | fallback parser 发现疑似工具调用但未解析成功；看 `modelTextPreview`、`rejected` |
| `upstream-error-response` | SZTU/APISIX 上游错误（如 502） |

```powershell
rg '"event":"tool-parse-miss"' .\claudecode\.runtime\claudecode-proxy.log
rg '"requestId":"cc_' .\claudecode\.runtime\claudecode-proxy.log
```
