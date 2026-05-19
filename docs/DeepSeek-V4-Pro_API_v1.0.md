# DeepSeek-V4-Pro API 接口文档

> **版本**：v1.0 | **日期**：2026-05-08 | **提供方**：鸿钧计算（深圳鸿钧计算科技有限公司）

---

## 1. 模型概述

DeepSeek-V4-Pro 是 DeepSeek AI 发布的旗舰级大语言模型，采用稀疏混合专家（MoE）架构，结合混合注意力机制（CSA/HCA），总参数量 1.6T，每个 token 激活约 49B 参数，最大支持 128K 上下文长度。

**核心能力：**

- 深度推理与思维链（Chain-of-Thought），通过 `reasoning_content` 字段返回，支持三档推理强度（Non-think / Think High / Think Max）
- 原生工具调用（Tool Calling）与并行工具调用
- 结构化 JSON 输出（支持 `json_object` 和 `json_schema` 模式）
- 代码生成与分析、数学推理与复杂问题求解
- 支持中文、英文及多种语言

---

## 2. 接入信息

### 2.1 接口地址

| 类型 | 地址 |
|------|------|
| 统一入口（推荐） | `https://apiai.sztu.edu.cn/v1/chat/completions` |

### 2.2 鉴权方式

在请求 Header 中携带 API Key：

```
Authorization: Bearer YOUR_API_KEY
```

### 2.3 请求规范

| 项目 | 说明 |
|------|------|
| 请求方法 | POST |
| Content-Type | application/json |
| 字符编码 | UTF-8 |
| 超时设置 | 连接 60s，读写 600s（长文本请适当调高） |

---

## 3. 接口详细说明

### 3.1 聊天补全 — Chat Completions

```
POST https://apiai.sztu.edu.cn/v1/chat/completions
```

请求 Body 为 JSON 格式，字段说明如下。

#### 3.1.1 基础参数

| 参数名 | 类型 | 是否必填 | 默认值 | 说明 |
|--------|------|----------|--------|------|
| model | string | 是 | — | 模型名称，固定传入 `deepseek-v4-pro` |
| messages | array | 是 | — | 对话消息列表，详见 3.2 节 |
| temperature | float | 否 | 1.0 | 采样温度，范围 [0, 2]。推理模式下被忽略 |
| top_p | float | 否 | 1.0 | 核采样，范围 (0, 1]。推理模式下被忽略 |
| max_tokens | int | 否 | — | 最大生成 token 数（含思维链）。推理复杂问题建议 ≥ 2000 |
| stream | bool | 否 | false | 是否启用流式输出（SSE） |
| stream_options | object | 否 | null | 流式统计配置，`{"include_usage": true}` 在最后一个 chunk 返回 usage |
| stop | string/array | 否 | — | 停止序列，触发后立即停止生成，最多 16 个 |
| frequency_penalty | float | 否 | 0.0 | 频率惩罚，范围 [-2.0, 2.0]。推理模式下被忽略 |
| presence_penalty | float | 否 | 0.0 | 存在惩罚，范围 [-2.0, 2.0]。推理模式下被忽略 |
| logprobs | bool | 否 | false | 是否返回 token 级对数概率。推理模式下不可用 |
| top_logprobs | int | 否 | — | 返回 top-k token 的 logprobs，范围 [0, 20]，需配合 `logprobs=true` |
| response_format | object | 否 | — | 输出格式控制，详见 3.4 节 |
| tools | array | 否 | — | 工具/函数定义列表，详见 3.5 节 |
| tool_choice | string/object | 否 | auto | 工具选择策略，详见 3.5 节 |

#### 3.1.2 DeepSeek-V4-Pro 特有参数

以下参数通过请求 Body 的 `chat_template_kwargs` 字段传入。使用 OpenAI SDK 时，请通过 `extra_body={"chat_template_kwargs": {...}}` 传递。

| 参数名 | 类型 | 可选值 | 默认值 | 说明 |
|--------|------|--------|--------|------|
| chat_template_kwargs.thinking | bool | true / false | true | 推理模式开关。true 开启思维链推理；false 关闭推理直接输出正文。不传时默认 true |
| chat_template_kwargs.reasoning_effort | string | "high" / "max" | "high" | 推理强度档位，仅 `thinking=true` 时生效。high：标准逻辑分析；max：全力推理（建议 `max_tokens` ≥ 4000） |

> **注意**：`thinking` 默认开启。非推理场景（普通对话、翻译等）建议显式传入 `{"thinking": false}` 关闭，可显著降低响应延迟并减少 token 消耗。

#### 3.1.3 SGLang 扩展采样参数（通过 extra_body 传入）

| 参数名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| top_k | int | -1（关闭） | Top-K 采样，-1 表示禁用 |
| min_p | float | 0.0 | 最小概率阈值采样 |
| repetition_penalty | float | 1.0 | 重复惩罚，>1 时抑制重复输出，推荐范围 1.0–1.2 |

### 3.2 messages 消息格式

`messages` 为对象数组，每个对象包含以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| role | string | 是 | system / user / assistant / tool |
| content | string | 视情况 | 消息内容；工具调用时 assistant 可为 null |
| reasoning_content | string | 否 | 多轮对话中可回传上轮思维链内容（建议不回传，详见 5. 注意事项） |
| tool_calls | array | 否 | assistant 消息中的工具调用列表 |
| tool_call_id | string | 否 | tool 角色消息中对应的工具调用 ID |

**示例：**

```json
[
    { "role": "system", "content": "你是一个有帮助的 AI 助手" },
    { "role": "user", "content": "请介绍一下你自己" }
]
```

### 3.3 响应格式

#### 3.3.1 非流式响应

```json
{
    "id": "chatcmpl-a1b2c3d4e5f6",
    "object": "chat.completion",
    "created": 1746700800,
    "model": "deepseek-v4-pro",
    "choices": [{
        "index": 0,
        "message": {
            "role": "assistant",
            "content": "最终回答内容",
            "reasoning_content": "思维链推理过程（thinking=true 时返回，否则为 null）",
            "tool_calls": []
        },
        "finish_reason": "stop"
    }],
    "usage": {
        "prompt_tokens": 12,
        "completion_tokens": 350,
        "total_tokens": 362,
        "completion_tokens_details": { "reasoning_tokens": 310 }
    }
}
```

#### 3.3.2 响应字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 请求唯一 ID |
| object | string | 固定为 `chat.completion` |
| created | int | Unix 时间戳（秒） |
| model | string | 实际使用的模型名称 |
| choices[].message.role | string | 固定为 assistant |
| choices[].message.content | string | 最终回答内容；工具调用时为 null |
| choices[].message.reasoning_content | string | 思维链推理过程。`thinking=true` 时返回，否则为 null |
| choices[].message.tool_calls | array | 工具调用列表，无调用时为空数组 |
| choices[].finish_reason | string | stop / length / tool_calls / content_filter |
| usage.prompt_tokens | int | 输入 token 数 |
| usage.completion_tokens | int | 生成 token 总数（含思维链部分） |
| usage.total_tokens | int | 总 token 数（prompt + completion） |
| completion_tokens_details.reasoning_tokens | int | 思维链消耗的 token 数（completion_tokens 的子集） |

#### 3.3.3 流式响应（SSE）

设置 `stream: true` 后，服务端以 Server-Sent Events 格式推送数据，每行格式为 `data: {...}`，结束标志为 `data: [DONE]`。

```
# 首个 chunk（role 声明）
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"deepseek-v4-pro",
      "choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

# 思维链阶段（delta.reasoning_content，先于 content 流出）
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"deepseek-v4-pro",
      "choices":[{"index":0,"delta":{"reasoning_content":"推理过程片段"},"finish_reason":null}]}

# 正文阶段（delta.content）
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"deepseek-v4-pro",
      "choices":[{"index":0,"delta":{"content":"生成内容片段"},"finish_reason":null}]}

# 结束 chunk
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"deepseek-v4-pro",
      "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

> **注意**：思维链内容（`delta.reasoning_content`）先于正文（`delta.content`）流出，两者顺序传输不重叠。如需在流式中获取 usage，可传入 `stream_options: {"include_usage": true}`，最后一个 chunk 将携带完整 usage 统计。

### 3.4 JSON 输出模式

通过 `response_format` 参数控制输出格式：

| 参数值 | 说明 |
|--------|------|
| `{"type": "text"}` | 默认，纯文本输出 |
| `{"type": "json_object"}` | 强制输出合法 JSON 对象。System Prompt 中需同时提示返回 JSON，否则可能输出异常 |
| `{"type": "json_schema", "json_schema": {...}}` | 按指定 JSON Schema 约束输出，支持 `strict: true` 严格模式。Schema 中所有 object 须将属性标为 required 且设 `additionalProperties: false` |

**json_schema 示例：**

```json
"response_format": {
    "type": "json_schema",
    "json_schema": {
        "name": "person",
        "strict": true,
        "schema": {
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "age": { "type": "integer" },
                "city": { "type": "string" }
            },
            "required": ["name", "age", "city"],
            "additionalProperties": false
        }
    }
}
```

### 3.5 工具调用（Function Calling）

DeepSeek-V4-Pro 原生支持并行工具调用，单次可返回多个工具调用结果。

#### 3.5.1 tools 参数格式

```json
"tools": [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "获取指定城市的天气信息",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": { "type": "string", "description": "城市名称" }
                },
                "required": ["city"]
            }
        }
    }
]
```

#### 3.5.2 tool_choice 属性

| 取值 | 说明 |
|------|------|
| `"auto"` | 模型自动决定是否调用工具（默认） |
| `"none"` | 禁止调用任何工具 |
| `"required"` | 强制必须调用至少一个工具 |
| `{"type":"function","function":{"name":"xxx"}}` | 强制调用指定名称的函数 |

#### 3.5.3 工具调用响应示例

```json
{
    "choices": [{
        "index": 0,
        "message": {
            "role": "assistant",
            "content": null,
            "reasoning_content": null,
            "tool_calls": [{
                "id": "chatcmpl-tool-86d187278aa1521e",
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "arguments": "{\"city\": \"深圳\"}"
                }
            }]
        },
        "finish_reason": "tool_calls"
    }]
}
```

> **注意**：`function.arguments` 为 JSON 编码的字符串，非 dict 对象，使用前需先进行 JSON 解析。

#### 3.5.4 工具结果回传

获取工具执行结果后，将结果作为 tool 角色消息回传给模型：

```json
{
    "role": "tool",
    "tool_call_id": "chatcmpl-tool-86d187278aa1521e",
    "content": "{\"temperature\": 28, \"condition\": \"sunny\"}"
}
```

---

## 4. 调用示例

### 4.1 普通对话（关闭推理）

**请求：**

```bash
curl -X POST https://apiai.sztu.edu.cn/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -d '{
        "model": "deepseek-v4-pro",
        "messages": [{"role": "user", "content": "你好，用一句话介绍你自己"}],
        "max_tokens": 100,
        "chat_template_kwargs": {"thinking": false}
    }'
```

**响应：**

```json
{
    "id": "chatcmpl-964b85dd13387c64",
    "object": "chat.completion",
    "created": 1746700800,
    "model": "deepseek-v4-pro",
    "choices": [{
        "index": 0,
        "message": {
            "role": "assistant",
            "content": "我是 DeepSeek-V4-Pro，一个强大的 AI 助手，致力于为你提供高效准确的解答。",
            "reasoning_content": null,
            "tool_calls": []
        },
        "finish_reason": "stop"
    }],
    "usage": {
        "prompt_tokens": 11,
        "completion_tokens": 22,
        "total_tokens": 33,
        "completion_tokens_details": {"reasoning_tokens": 0}
    }
}
```

### 4.2 深度推理模式（Think High）

**请求：**

```bash
curl -X POST https://apiai.sztu.edu.cn/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -d '{
        "model": "deepseek-v4-pro",
        "messages": [{"role": "user", "content": "9.11 和 9.8 哪个大？"}],
        "max_tokens": 2000,
        "chat_template_kwargs": {"thinking": true, "reasoning_effort": "high"}
    }'
```

**响应：**

```json
{
    "id": "chatcmpl-ad8344d9643973d6",
    "object": "chat.completion",
    "created": 1746700800,
    "model": "deepseek-v4-pro",
    "choices": [{
        "index": 0,
        "message": {
            "role": "assistant",
            "content": "9.8 更大。整数部分相同，十分位 8 > 1，所以 9.8 > 9.11。",
            "reasoning_content": "用户在比较 9.11 和 9.8 的大小。这是一个经典的小数比较问题...",
            "tool_calls": []
        },
        "finish_reason": "stop"
    }],
    "usage": {
        "prompt_tokens": 15,
        "completion_tokens": 320,
        "total_tokens": 335,
        "completion_tokens_details": {"reasoning_tokens": 295}
    }
}
```

### 4.3 流式输出

**请求：**

```bash
curl -N -X POST https://apiai.sztu.edu.cn/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -d '{
        "model": "deepseek-v4-pro",
        "messages": [{"role": "user", "content": "写一首关于深圳的短诗"}],
        "max_tokens": 200,
        "stream": true,
        "chat_template_kwargs": {"thinking": false}
    }'
```

**响应（SSE 片段）：**

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"deepseek-v4-pro",
      "choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"deepseek-v4-pro",
      "choices":[{"index":0,"delta":{"content":"风"},"finish_reason":null}]}

... （省略中间 chunks）

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"deepseek-v4-pro",
      "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### 4.4 工具调用

**请求：**

```bash
curl -X POST https://apiai.sztu.edu.cn/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -d '{
        "model": "deepseek-v4-pro",
        "messages": [{"role": "user", "content": "今天深圳天气怎样？"}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "获取城市当前天气",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"]
                }
            }
        }],
        "tool_choice": "auto",
        "chat_template_kwargs": {"thinking": false}
    }'
```

### 4.5 结构化 JSON 输出（json_schema）

**请求：**

```bash
curl -X POST https://apiai.sztu.edu.cn/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -d '{
        "model": "deepseek-v4-pro",
        "messages": [{"role": "user", "content": "生成一个人物信息"}],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "person",
                "strict": true,
                "schema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "age": {"type": "integer"},
                        "city": {"type": "string"}
                    },
                    "required": ["name", "age", "city"],
                    "additionalProperties": false
                }
            }
        },
        "chat_template_kwargs": {"thinking": false}
    }'
```

**响应：**

```json
{
    "id": "chatcmpl-873ac290b9b9a184",
    "object": "chat.completion",
    "created": 1746700800,
    "model": "deepseek-v4-pro",
    "choices": [{
        "index": 0,
        "message": {
            "role": "assistant",
            "content": "{ \"name\": \"林野\", \"age\": 24, \"city\": \"深圳\" }",
            "reasoning_content": null,
            "tool_calls": []
        },
        "finish_reason": "stop"
    }],
    "usage": {
        "prompt_tokens": 9,
        "completion_tokens": 27,
        "total_tokens": 36,
        "completion_tokens_details": {"reasoning_tokens": 0}
    }
}
```

### 4.6 Python SDK 调用示例

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="https://apiai.sztu.edu.cn/v1"
)

# 普通对话（关闭推理）
resp = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[
        {"role": "system", "content": "你是一个有帮助的 AI 助手。"},
        {"role": "user", "content": "你好"},
    ],
    max_tokens=512,
    extra_body={"chat_template_kwargs": {"thinking": False}}
)
print(resp.choices[0].message.content)

# 深度推理模式（获取思维链）
resp = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "content": "9.11 和 9.8 哪个大？"}],
    max_tokens=2000,
    extra_body={"chat_template_kwargs": {"thinking": True, "reasoning_effort": "high"}}
)
print("思维链：", resp.choices[0].message.reasoning_content)
print("回答：", resp.choices[0].message.content)
```

### 4.7 多轮对话示例

以下示例展示如何正确构造多轮对话的 messages 列表：

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="https://apiai.sztu.edu.cn/v1"
)

messages = [{"role": "system", "content": "你是一个有帮助的 AI 助手。"}]

# 第一轮
messages.append({"role": "user", "content": "深圳有哪些著名景点？"})
resp = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages,
    max_tokens=500,
    extra_body={"chat_template_kwargs": {"thinking": False}}
)
reply = resp.choices[0].message.content
print("第一轮：", reply)

# 回传时不包含 reasoning_content
messages.append({"role": "assistant", "content": reply})

# 第二轮
messages.append({"role": "user", "content": "其中哪个最适合带小孩去？"})
resp = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages,
    max_tokens=500,
    extra_body={"chat_template_kwargs": {"thinking": False}}
)
print("第二轮：", resp.choices[0].message.content)
```

---

## 5. 注意事项

- 推理模式默认开启（`thinking=true`）。非推理场景建议显式传入 `{"thinking": false}` 关闭，可大幅降低延迟并节省 token。
- 开启推理模式时，`temperature`、`top_p`、`presence_penalty`、`frequency_penalty` 参数将被静默忽略，不会触发报错。
- `max_tokens` 同时限制思维链与正文的总生成长度。推理复杂问题建议 ≥ 2000；Think Max 模式建议 ≥ 4000。
- 当前服务最大上下文长度为 131072 tokens（128K），超出将返回错误。
- 多轮对话中，建议不将上轮 assistant 消息的 `reasoning_content` 字段回传，以避免不必要的 token 消耗和注意力偏移。
- 工具调用时，`function.arguments` 为 JSON 编码的字符串，非 dict 对象，使用前需先进行 JSON 解析。
- tool 角色的 `content` 字段必须为字符串类型，不可传入数组或对象。
- 流式模式下，思维链通过 `delta.reasoning_content` 流出，正文通过 `delta.content` 流出，顺序传输不重叠。
- 使用 `json_schema` 模式时，Schema 中所有 object 类型须将属性标为 required 且设 `additionalProperties: false`，否则可能导致输出不符合预期。

---

## 6. 错误码说明

| HTTP 状态码 | 错误类型 | 说明及处理建议 |
|-------------|----------|----------------|
| 400 | Bad Request | 请求参数格式错误，检查 JSON 格式及必填字段 |
| 401 | Unauthorized | API Key 无效或未传入，检查 Authorization 头部 |
| 422 | Unprocessable Entity | 参数值超出范围或 model 字段不匹配，检查参数取值 |
| 429 | Too Many Requests | 请求频率超限，建议添加重试逻辑（推荐指数退避） |
| 500 | Internal Server Error | 服务端内部错误，可重试，持续出现请联系技术支持 |
| 503 | Service Unavailable | 服务暂时不可用，通常为短暂过载，稍后重试 |

**错误响应体格式：**

```json
{
    "object": "error",
    "message": "Model not found: deepseek-v4",
    "type": "invalid_request_error",
    "code": 400
}
```

---

## 附录：模型属性列表

| 属性 | 值 |
|------|-----|
| 模型名称 | deepseek-v4-pro |
| 总参数量 | 1.6T |
| 每 token 激活参数 | ~49B |
| 最大上下文 | 131072 tokens（128K） |
| 默认 temperature | 1.0 |
| 默认 top_p | 1.0 |
| 支持语言 | 中文、英文及多种语言 |
| 支持工具调用 | 是（支持并行调用） |
| 推理模式 | 三档：Non-think / Think High / Think Max |
| 支持 JSON 输出 | 是（json_object / json_schema 模式） |
| 支持流式输出 | 是（SSE） |
| 支持图片输入 | 否（纯文本模型） |
| 架构 | 稀疏混合专家（MoE）+ 混合注意力（CSA/HCA） |
