# Claude Code × SZTU DeepSeek 代理

当前代理**仅针对 `deepseek-v4-pro` 优化**（GLM 暂不维护）。

## 启动

```powershell
# 仓库根目录 .env
# SZTU_API_KEY=你的密钥
# SZTU_DEFAULT_MODEL=deepseek-v4-pro   # 可选，默认已是 deepseek

node .\claudecode\claudecode-proxy.js
```

将本目录 `settings.json` 合并到 Claude Code 配置，或设置环境变量指向 `http://127.0.0.1:8790`。

## DeepSeek 优化点

- 所有 Claude 模型名统一路由到 `deepseek-v4-pro`
- 推理按 **CC 每次请求的 `thinking` 字段** 映射：`enabled` / `adaptive` → 开，`disabled` → 关；未带时默认开启
- 工具桥接支持多种 DeepSeek 输出格式（见 `docs/implementation-notes.md` 的 Tool Output Formats）
- 解析后按 CC 的 `input_schema.properties` 过滤字段，避免模型编造 `limit` 等非法参数
- 「总结 / 项目结构」类提示优先注入 Read、Glob、Grep，减少乱用 Bash

## 测试

```powershell
node .\scripts\test-tool-parser.js
node .\scripts\test-api.js claudecode
```

## 日志

`claudecode/.runtime/claudecode-proxy.log`（JSONL，已在 `.gitignore`）

| event | 含义 |
|-------|------|
| `request` | 客户端与上游摘要；含 `client.thinking`、`upstream.chat_template_kwargs` |
| `tool-parse-hit` | 模型文本已转为 `tool_use`；看 `matchedFormat`、`inputKeys`、`inputPreview`、`strippedKeys` |
| `tool-parse-miss` | 像工具调用但未解析成功；看 `modelTextPreview`、`rejected` |
| `request` | 含 `client_thinking`、`deepseek_thinking` 与上下游摘要 |
| `upstream-error-response` | SZTU/APISIX 上游错误（如 502） |

```powershell
rg '"event":"tool-parse-miss"' .\claudecode\.runtime\claudecode-proxy.log
rg '"requestId":"cc_' .\claudecode\.runtime\claudecode-proxy.log
```
