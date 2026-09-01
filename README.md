# JLCircuit Agent

嘉立创智能电路助手的本地可运行 MVP。

项目采用“本地嘉立创EDA扩展负责执行，后端 Agent 负责理解与编排”的结构。当前已形成 WebSocket EDA Bridge、多轮会话、声明式技能、MCP Gateway，以及带来源引用的本地资料库：

```text
用户 / 面板
    ↓
Agent Service
    ↓ 结构化 ToolRequest / ToolResponse
Local EDA Bridge
    ↓ 嘉立创EDA扩展 API
嘉立创EDA
```

## 目录

- `apps/agent-service`：会话、规划和工具编排服务。
- `skills/builtin`：受控的声明式技能清单与工作流说明。
- `packages/contracts`：前后端共享的 Design IR、ChangeSet 和消息协议。
- `packages/bridge`：面向 EDA 执行端的类型化能力边界。
- `extensions/jlcircuit-eda`：嘉立创EDA扩展入口、助手面板和 API 适配器。
- `docs/current-architecture.md`：完整目标架构、当前实现状态、流程、接口、安全边界和分阶段开发路线。

## 本地运行

当前仓库使用 Node.js HTTP 服务、WebSocket Bridge 和 TypeScript 类型定义，先安装依赖：

```bash
npm install
npm run dev
```

构建嘉立创EDA扩展包：

```bash
npm run build:extension
```

输出文件：

```text
extensions/jlcircuit-eda/build/dist/jlcircuit-agent_v0.3.9.eext
```

在嘉立创EDA专业版 V3 中选择“高级 → 扩展管理器 → 导入”，导入上面的 `.eext` 文件；V2 可从“设置 → 扩展 → 扩展管理器 → 导入扩展”进入。扩展需要开启 External Interaction 权限，运行时通过官方 `eda.sys_WebSocket` 连接本地 Agent 服务。

服务默认监听 `http://127.0.0.1:49630`，健康检查：

```text
GET /health
```

工具入口：

```text
GET  /v1/tools
GET  /v1/skills
POST /v1/skills/reload
POST /v1/skills/:skillId/enable
POST /v1/skills/:skillId/disable
GET  /v1/mcp/servers
GET  /v1/mcp/config
POST /v1/mcp/reload
POST /v1/mcp/servers
POST /v1/mcp/servers/:serverId/update
POST /v1/mcp/servers/:serverId/delete
POST /v1/mcp/servers/:serverId/enable
POST /v1/mcp/servers/:serverId/disable
POST /v1/mcp/servers/:serverId/connect
POST /v1/mcp/servers/:serverId/disconnect
POST /v1/mcp/servers/:serverId/test
GET  /v1/mcp/servers/:serverId/capabilities
GET  /v1/mcp/servers/:serverId/resources
POST /v1/mcp/servers/:serverId/resources/read
GET  /v1/mcp/servers/:serverId/prompts
POST /v1/mcp/servers/:serverId/prompts/get
GET  /v1/knowledge/sources
POST /v1/knowledge/sources
POST /v1/knowledge/reindex
POST /v1/knowledge/sources/:sourceId/update
POST /v1/knowledge/sources/:sourceId/delete
POST /v1/knowledge/sources/:sourceId/scan
GET  /v1/knowledge/sources/:sourceId/documents
POST /v1/knowledge/search
POST /v1/knowledge/read
POST /v1/tools/:toolName
POST /v1/sessions
GET  /v1/sessions/:sessionId
GET  /v1/sessions/:sessionId/audit
POST /v1/sessions/:sessionId/clear
POST /v1/context
POST /v1/drc
POST /v1/chat
POST /v1/chat/stream
POST /v1/plan
GET  /v1/providers
POST /v1/providers/:providerId/restart
GET  /v1/tasks/:taskId
POST /v1/tasks/:taskId/retry
POST /v1/tasks/:taskId/confirm
POST /v1/tasks/:taskId/cancel
POST /v1/tools/easyeda_canvas_locate
POST /v1/tools/easyeda_canvas_capture
POST /v1/tools/easyeda_canvas_capture_region
POST /v1/tools/easyeda_post_write_verify
WS   ws://127.0.0.1:49630/bridge
```

## 接入大语言模型

Agent Service 默认使用 **Codex App Server** 作为智能体内核。JLCircuit 自己保留 Session、Skill、EDA 工具权限、ChangeSet 确认、Bridge 和验证链；Codex App Server 负责持久化模型线程、工具循环、推理/正文流和 token 统计。每个模型 Provider 对应一个按需启动的 `codex app-server` 子进程，同一 Provider 的会话复用该进程，不会修改用户的 Codex 全局配置。

先安装并确认 `codex --version` 可用，然后复制环境和 Provider 示例：

```powershell
$envFile = ".env"
Copy-Item .env.example $envFile
New-Item -ItemType Directory -Force .jlcircuit-data | Out-Null
Copy-Item config/codex-providers.example.json .jlcircuit-data/codex-providers.json

# 也可以把这些值写入项目根目录的 .env
$env:OPENAI_API_KEY="你的API密钥"
npm run dev
```

Provider 配置使用 `apiKeyEnv` 引用密钥，不保存密钥值；`httpHeaders` 只允许非敏感静态头，Authorization/API-Key 类头及常见密钥 Query 参数会被拒绝，应改用 `apiKeyEnv` 或 `envHttpHeaders`。`.env` 与 `.jlcircuit-data/` 均已被 Git 忽略。完整示例见 `config/codex-providers.example.json`：

```json
{
  "defaultProvider": "openrouter",
  "providers": {
    "openrouter": {
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "openai/gpt-5.4",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "wireApi": "responses",
      "reasoningEffort": "high",
      "modelMetadata": {
        "contextWindow": 262144,
        "maxOutputTokens": 32768,
        "inputModalities": ["text", "image"],
        "reasoningEfforts": ["low", "high"],
        "defaultReasoningEffort": "high"
      },
      "enabled": true
    }
  }
}
```

```env
JLCIRCUIT_AGENT_BACKEND=codex-app-server
JLCIRCUIT_CODEX_COMMAND=codex
JLCIRCUIT_CODEX_PROVIDERS_CONFIG=.jlcircuit-data/codex-providers.json
JLCIRCUIT_CODEX_HOME_ROOT=.jlcircuit-data/codex-home
JLCIRCUIT_CODEX_MAX_PROCESSES=4
JLCIRCUIT_CODEX_REQUEST_TIMEOUT_MS=30000
OPENROUTER_API_KEY=你的API密钥
```

本集成当前只接受 `wireApi: "responses"`。例如 OpenRouter 的 Base URL 填 `https://openrouter.ai/api/v1`，Codex 会调用其 `/responses`；只有 Chat Completions 的兼容后端不能直接放进该进程池。对 Codex 内置目录没有的第三方模型，应配置 `modelMetadata`：服务会在 `.jlcircuit-data/codex-home/<id>/jlcircuit-model-catalog.json` 生成该 Provider 专用目录，并用 `model_catalog_json` 仅注入对应的 App Server 进程，消除“Model metadata not found”的兜底行为；该目录不含密钥，也不修改用户全局 Codex 配置。`contextWindow` 必须大于 `maxOutputTokens`，`inputModalities` 必须含 `text`，并且默认推理档位必须出现在 `reasoningEfforts` 中。Provider 的 `baseUrl`、`model`、`wire_api` 和密钥环境变量通过当前子进程的启动参数/环境注入，仅作用于 JLCircuit 启动的 App Server。每个 Provider 使用独立 `CODEX_HOME` 和空工作目录，不读取用户全局 Codex Skills/MCP/配置；子进程还显式禁用 Plugin/App/Hook/Skill Search、Shell/Unified Exec、Browser/Computer Use 和多智能体等内置能力，只保留 JLCircuit 动态工具。子进程环境只保留操作系统运行所需变量、本 Provider 密钥及 `envHttpHeaders` 明确引用的变量，不继承其他 Provider 密钥。修改 Provider JSON 后需要重启 Agent Service；EDA 输入区可以选择本轮 Provider。

`GET /v1/providers` 可查看 Provider、密钥环境变量是否存在及子进程状态；`POST /v1/providers/:id/restart` 可重启单个 Provider 进程，该管理操作受本地管理 Origin/Token 保护。每个 `(sessionId, providerId)` 的 Codex thread ID 持久化在 SQLite，服务重启后通过 `thread/resume` 恢复。清空对话时会同时删除该会话的 thread 映射。

需要兼容旧的 Chat Completions 供应商时，可设置 `JLCIRCUIT_AGENT_BACKEND=legacy`，继续使用 `JLCIRCUIT_MODEL_PROVIDER`、`JLCIRCUIT_LLM_BASE_URL`、`JLCIRCUIT_LLM_API_KEY` 和 `JLCIRCUIT_LLM_MODEL`。这是迁移回退路径，不经过 Provider 进程池。

### 图像识别模型路由

Codex App Server 后端会把截图工具返回的 PNG 作为动态工具的 `inputImage` 交回当前 Provider，因此应选择支持图像输入的模型。当前独立视觉模型路由仅由 `legacy` 后端使用；Codex 进程池的跨 Provider 视觉降级仍在开发。

当模型可以识别图片时，将截图直接交给当前语言模型：

```env
JLCIRCUIT_LLM_SUPPORTS_VISION=true
```

当当前语言模型不支持图片时，将该项设为 `false`，并配置独立的视觉模型：

```env
JLCIRCUIT_LLM_SUPPORTS_VISION=false
JLCIRCUIT_VISION_LLM_BASE_URL=https://api.openai.com/v1
JLCIRCUIT_VISION_LLM_API_KEY=视觉模型密钥
JLCIRCUIT_VISION_LLM_MODEL=gpt-4o-mini
JLCIRCUIT_VISION_LLM_TIMEOUT_MS=120000
JLCIRCUIT_LLM_MAX_TOKENS=4096
JLCIRCUIT_LLM_STREAMING=true
# Z.AI 流式 Function Call；provider=zai 时默认启用，其他供应商默认关闭
JLCIRCUIT_LLM_TOOL_STREAM=true
JLCIRCUIT_LLM_REASONING_EFFORT=low
JLCIRCUIT_LLM_FINAL_REASONING_EFFORT=minimal
JLCIRCUIT_LLM_MAX_LENGTH_RECOVERIES=1
JLCIRCUIT_LLM_CONTEXT_MAX_CHARS=40000
JLCIRCUIT_LLM_CONTEXT_MAX_ITEMS=200
JLCIRCUIT_LLM_TOOL_RESULT_MAX_CHARS=50000
JLCIRCUIT_AGENT_MAX_TOOL_CALLS=40
JLCIRCUIT_AGENT_MAX_ELAPSED_MS=300000
JLCIRCUIT_AGENT_MAX_NO_PROGRESS=2
JLCIRCUIT_AGENT_MAX_RETRIES_PER_ACTION=2
JLCIRCUIT_AGENT_FINALIZE_TIMEOUT_MS=60000
```

视觉模型的地址和密钥可以省略，此时复用 `JLCIRCUIT_LLM_BASE_URL` 和 `JLCIRCUIT_LLM_API_KEY`，只替换模型名即可。配置的地址既可以是 `https://provider.example/v1`，也可以直接带 `/chat/completions`；服务会自动规范化，避免重复拼接路径。

模型调用画布截图时会先保留结构化工具结果，再追加一条包含 PNG Base64 的视觉消息，并要求模型检查元件/网络标签、断线悬空、文字碰撞、拥挤和不合理交叉。没有截图时仍只调用当前语言模型。

`JLCIRCUIT_LLM_MAX_TOKENS` 限制单次模型输出（包括 reasoning）长度；`JLCIRCUIT_LLM_CONTEXT_MAX_CHARS` 限制发送给模型的设计上下文字符数；`JLCIRCUIT_LLM_CONTEXT_MAX_ITEMS` 限制元件和导线样例数量。服务会保留总数和截断标记，Agent 返回的原始上下文不受影响。

默认启用端到端流式输出：Codex App Server 将 reasoning、正文、动态工具状态和 `thread/tokenUsage/updated` 通过 JSON-RPC 推送给 Agent Service，Agent Service 再通过 `POST /v1/chat/stream` 的 SSE 转发给 EDA 面板。`legacy` 后端则继续直接读取 OpenAI-compatible SSE。面板顶部具有位于对话滚动区之外的常驻运行状态栏，持续显示阶段、耗时、模型请求数、工具调用数及 token，执行结束后保留最近一次状态和最终用量。思考区默认跟随最新输出滚到底部；用户向上滚动后暂停跟随，手动回到底部时自动恢复。执行结束后推理区域自动折叠，最终答案保持展开。

助手回复支持常用 Markdown 格式，包括标题、粗体/斜体、列表、引用、表格、链接、行内代码和 fenced code block；流式输出与历史消息使用同一渲染器，代码和链接会以安全 DOM 节点呈现。

`reasoningEffort` 在 Codex Provider JSON 中按 Provider 配置。`JLCIRCUIT_LLM_MAX_TOKENS`、长度恢复与 `JLCIRCUIT_LLM_FINAL_REASONING_EFFORT` 属于 `legacy` 后端；Codex App Server 后端由 Codex 管理单轮模型输出和工具续接，JLCircuit 只保留总工具数与总耗时熔断。

Agent 不再按固定模型请求轮数停止。Codex App Server 在一个 turn 内持续执行到最终答复、等待用户、产生待确认写操作、被中断或明确失败；JLCircuit 只用 `JLCIRCUIT_AGENT_MAX_TOOL_CALLS` 和 `JLCIRCUIT_AGENT_MAX_ELAPSED_MS` 做异常熔断。`JLCIRCUIT_AGENT_MAX_NO_PROGRESS`、`JLCIRCUIT_AGENT_MAX_RETRIES_PER_ACTION` 和最终阶段总结属于 `legacy` Supervisor。

### 会话持久化与上下文引擎

Agent Service 使用 Node.js 内置 SQLite 保存会话、消息、任务、最新 EDA 快照和审计事件，默认数据库为 `.jlcircuit-data/jlcircuit-agent.sqlite`。该目录已被 Git 忽略；可通过 `JLCIRCUIT_DB_PATH` 修改位置。Node.js 版本要求为 24 或更高。

每轮请求会先写入用户消息，再读取最新 EDA 快照，并由 Context Engine 组合较早会话的滚动摘要、最近多轮对话、仍在等待补充或确认的任务以及当前原理图/PCB 上下文。EDA 快照和对话历史分别控制预算，避免历史消息挤占设计数据：

```env
JLCIRCUIT_CONTEXT_RECENT_MESSAGES=12
JLCIRCUIT_CONTEXT_HISTORY_MAX_CHARS=12000
JLCIRCUIT_CONTEXT_SUMMARY_MAX_CHARS=6000
JLCIRCUIT_CONTEXT_ACTIVE_TASKS=5
JLCIRCUIT_CONTEXT_TASK_MAX_CHARS=6000
```

`GET /v1/sessions/:sessionId` 可恢复最近消息和任务；EDA 助手面板启动时会自动调用该接口。界面的“清空对话”会删除该会话的消息和滚动摘要，但不会删除任务及审计记录。服务重启后，待确认任务和确认令牌仍可恢复。

EDA 面板会按当前项目 ID 生成独立的 `sessionId`，不同工程不会共享对话历史。后端也会校验会话绑定的项目；如果 API 客户端错误地把同一会话用于另一个项目，请求会被阻止并要求创建新的会话。

### 声明式技能

服务启动时会加载 `skills/builtin/*/skill.json`，并可通过 `JLCIRCUIT_SKILL_ROOTS` 加载额外的受信目录。每个技能由 `skill.json` 和同目录内的 `SKILL.md` 组成，声明启用条件、适用模式、允许/必需工具和风险级别。当前内置 `eda-core`、`schematic-layout`、`mcp-assistant`、`local-knowledge` 与 `datasheet-review`；面板可选择“自动”或明确指定一个技能。

```env
JLCIRCUIT_SKILL_ROOTS=C:\trusted\jlcircuit-skills
JLCIRCUIT_SKILL_AUTO_ACTIVATE=true
JLCIRCUIT_SKILL_MAX_ACTIVE=3
JLCIRCUIT_SKILL_MAX_INSTRUCTION_CHARS=20000
```

自动模式会启用 always 技能，并按用户指令关键字选择专用技能。模型只会看到这些技能联合允许的工具；只读工具可以在对话中执行，写工具只会转换为待确认的 `ChangeSet`，不会在模型回合中直接写入。技能启停状态保存在 SQLite。技能入口必须留在自身目录内，未知工具、重复 ID、越界入口和过大的说明文件会被拒绝。当前技能是声明和提示词，不会执行技能目录中的任意脚本；外部 MCP 工具由下述 MCP 插件网关独立加载和约束。

`POST /v1/chat`、`POST /v1/chat/stream` 和兼容接口 `POST /v1/plan` 可传 `skillIds` 数组明确选择技能；省略时自动选择：

```json
{"sessionId":"demo","instruction":"检查并改善原理图布局","skillIds":["schematic-layout"]}
```

### MCP 插件网关

阶段 4 的 MCP Gateway 使用官方 `@modelcontextprotocol/client`，支持本地 `stdio` 和远程 Streamable HTTP。默认配置文件为 `.jlcircuit-data/mcp-servers.json`，该目录被 Git 忽略。先复制示例：

```powershell
New-Item -ItemType Directory -Force .jlcircuit-data | Out-Null
Copy-Item config/mcp-servers.example.json .jlcircuit-data/mcp-servers.json
```

完整配置示例（仓库中也提供了 `config/mcp-servers.example.json`）：

```json
{
  "schemaVersion": 1,
  "servers": [
    {
      "id": "local-example",
      "name": "本地 MCP 示例",
      "enabledByDefault": false,
      "transport": {
        "type": "stdio",
        "command": "node",
        "args": ["C:\\absolute\\path\\to\\server.mjs"],
        "cwd": "C:\\absolute\\path\\to",
        "env": ["EXAMPLE_API_KEY"]
      },
      "allowedTools": ["read_component_data"],
      "defaultRiskLevel": "high",
      "toolRiskLevels": {
        "read_component_data": "read"
      },
      "allowResources": false,
      "allowPrompts": false
    },
    {
      "id": "remote-example",
      "name": "远程 MCP 示例",
      "enabledByDefault": false,
      "transport": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "bearerTokenEnv": "REMOTE_MCP_TOKEN"
      },
      "allowedTools": [],
      "defaultRiskLevel": "high",
      "toolRiskLevels": {},
      "allowResources": false,
      "allowPrompts": false
    }
  ]
}
```

本地 `stdio` Server 通过 `command`、`args` 和可选 `cwd` 启动；`env` 只填写允许转交给子进程的环境变量名称。远程 Server 使用 `url`，认证令牌由 `bearerTokenEnv` 指向 Agent 服务进程中的环境变量。不要把 API Key 或 Token 的实际值写入 JSON。

配置中的服务器默认关闭。修改命令、URL 和 allowlist 后，可通过 API 启用并连接：

```powershell
$headers = @{}
if ($env:JLCIRCUIT_ADMIN_TOKEN) { $headers["x-jlcircuit-admin-token"] = $env:JLCIRCUIT_ADMIN_TOKEN }
Invoke-RestMethod -Method Post -Headers $headers http://127.0.0.1:49630/v1/mcp/reload
Invoke-RestMethod -Method Post -Headers $headers http://127.0.0.1:49630/v1/mcp/servers/local-example/enable
Invoke-RestMethod http://127.0.0.1:49630/v1/mcp/servers
```

MCP 工具会转换成 `mcp__<server>__<tool>` 命名空间，并通过 `mcp-assistant` 技能进入模型工具列表。安全默认值如下：

- 服务器必须显式启用；
- 工具必须出现在 `allowedTools`，`"*"` 表示明确允许该服务器的全部工具；
- 未覆盖风险级别的外部工具默认为 `high`；
- 当前只执行风险为 `read` 的 MCP 工具，外部写工具不提供给模型；
- `http://` 只允许回环地址，远程地址必须使用 HTTPS；
- 密钥只通过 `env` 或 `bearerTokenEnv` 引用环境变量，不能写入配置文件；
- Resources 和 Prompts 分别需要 `allowResources`、`allowPrompts`，读取范围限制为已发现条目；
- 调用有超时、结果大小限制和 SQLite 审计。

EDA 面板顶部显示 MCP 已连接数量，“MCP 管理”可以直接新增、编辑、删除配置，启用或禁用 Server，连接、断开、测试连接，并查看已发现的 Tools、Resources 和 Prompts。配置保存使用临时文件加原子替换；Server ID 创建后不能修改，密钥值不会进入配置文件。

MCP 与本地资料库管理接口只在 Agent Service 绑定回环地址且请求来自本机时开放。建议在 `.env` 中配置统一管理令牌；EDA 管理窗口会要求输入该令牌，并只在当前 EDA 会话的 `sessionStorage` 中保存：

```env
JLCIRCUIT_ADMIN_TOKEN=请替换为足够长的随机值
# Agent 自身的 127.0.0.1/localhost/[::1] Origin 已默认允许；这里只填写额外 Origin
JLCIRCUIT_ADMIN_ALLOWED_ORIGINS=
```

带管理令牌的命令行调用示例：

```powershell
$headers = @{ "x-jlcircuit-admin-token" = $env:JLCIRCUIT_ADMIN_TOKEN }
Invoke-RestMethod -Headers $headers http://127.0.0.1:49630/v1/mcp/config
Invoke-RestMethod -Method Post -Headers $headers http://127.0.0.1:49630/v1/mcp/reload
```

当前仍没有插件商店、OAuth 交互授权、自动安装、失败自动重连或外部写操作执行器。

### 本地资料库

阶段 5 的基础闭环允许用户显式授权本机目录，索引芯片手册、参考说明、BOM 和网表，再让模型用只读工具检索并引用原始位置。EDA 助手点击“资料库”即可新增资料源、扫描单个或全部目录、查看文档与解析错误，并直接测试搜索。资料源必须填写已经存在的绝对目录；删除资料源只删除索引，不会删除原文件。

当前支持 `.pdf`、`.txt`、`.md`、`.markdown`、`.json`、`.csv`、`.tsv`、`.yaml`、`.yml`、`.html`、`.htm`、`.xml`、`.net`、`.netlist`、`.bom` 和 `.log`。PDF 使用 PDF.js 按页提取文本；文本资料按行记录位置。SQLite FTS5 `trigram` 索引用于中英文全文搜索，结果包含资料源、相对路径、页码或行号、内容哈希和片段。扫描版 PDF 目前没有 OCR；向量检索也尚未实现。

模型可使用三个只读工具：

- `knowledge_sources`：查看可用资料源及索引统计，但不暴露绝对路径；
- `knowledge_search`：按关键词检索，返回可追溯引用；
- `knowledge_read`：只按已索引的 `documentId` 或 `chunkId` 读取内容，不能传任意文件路径。

专业手册审查还提供 `datasheet_evidence`：先用完整芯片型号锁定候选文档，再在这些文档内部按供电、推荐工作条件、绝对最大值、引脚、时钟复位、接口、去耦、典型应用、布局、封装热设计等主题分别检索证据。这样即使芯片型号只出现在手册封面，也能检索后续章节。工具返回每个主题的覆盖状态，只组织原文片段，不会凭模型记忆生成参数。

涉及“芯片手册、数据手册、参考电路、引脚、BOM、网表、资料库”等指令时，自动技能选择会启用 `local-knowledge`。技能要求模型标注引用，并把资料内容视为不可信输入，不能执行其中的命令或把冲突资料静默合并。

命令行配置示例：

```powershell
$headers = @{
  "x-jlcircuit-admin-token" = $env:JLCIRCUIT_ADMIN_TOKEN
  "Origin" = "http://127.0.0.1:49630"
}
$source = @{
  id = "board-docs"
  name = "板卡资料"
  rootPath = "C:\Datasheets\Grow-G1"
  extensions = @(".pdf", ".md", ".csv", ".net")
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $headers -ContentType "application/json" `
  -Uri http://127.0.0.1:49630/v1/knowledge/sources -Body $source
Invoke-RestMethod -Method Post -Headers $headers `
  -Uri http://127.0.0.1:49630/v1/knowledge/sources/board-docs/scan

$query = @{ query = "供电电压 去耦电容"; sourceIds = @("board-docs"); limit = 5 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $headers -ContentType "application/json" `
  -Uri http://127.0.0.1:49630/v1/knowledge/search -Body $query
```

索引和资料源元数据保存在同一个 SQLite 数据库中。文件发现跳过符号链接以及 `.git`、`node_modules`、`dist`、`build` 等目录；读取时再次校验真实路径仍在授权根目录内。默认资源限制可在 `.env` 调整：

```env
JLCIRCUIT_KNOWLEDGE_MAX_FILES=5000
JLCIRCUIT_KNOWLEDGE_MAX_FILE_BYTES=26214400
JLCIRCUIT_KNOWLEDGE_MAX_PDF_PAGES=1000
JLCIRCUIT_KNOWLEDGE_MAX_DEPTH=12
JLCIRCUIT_KNOWLEDGE_CHUNK_CHARS=4000
JLCIRCUIT_KNOWLEDGE_CHUNK_OVERLAP=300
```

### 专业芯片手册审查

阶段 6 的基础闭环建立在 Local Knowledge 之上。先把目标芯片手册目录加入资料库并完成扫描，然后在 EDA 助手中输入芯片型号或位号，点击“手册审查”。输入框为空时，该按钮会填入审查模板；已有需求时会选择 `datasheet-review` 技能并直接发送。

示例：

```text
审查当前原理图中 U3（STM32F103C8T6）的供电、推荐工作条件、所有 VDD/VDDA 去耦、复位和晶振电路，逐项引用手册，并把无法从当前 EDA 数据确认的项目单独列出。
```

专业流程会：

1. 确认完整料号；不把位号、系列名或封装名当成完整型号；
2. 用 `datasheet_evidence` 按主题建立证据包，必要时展开原始分块；
3. 读取当前 EDA 元件、导线和 DRC，与手册要求逐项对照；
4. 将结论限制为“符合、不符合、证据不足、当前 EDA 数据不足”；
5. 对每个数值、引脚功能和典型应用要求标注相对文件、页码/行号和 SHA-256。

也可以直接验证专业工具：

```powershell
$body = @{
  sessionId = "datasheet-demo"
  payload = @{
    partNumber = "STM32F103C8T6"
    aspects = @("power", "recommended_conditions", "absolute_maximum", "pinout", "decoupling", "reference_circuit")
    perAspectLimit = 3
  }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -ContentType "application/json" `
  -Uri http://127.0.0.1:49630/v1/tools/datasheet_evidence -Body $body
```

当前版本不会把检索片段自动固化成永久芯片参数数据库，也不会仅凭 DRC 通过宣称参考电路正确。扫描版 PDF 仍需要后续 OCR；部分嘉立创 EDA 版本不能完整返回引脚到网络的映射时，结果会标记为“当前 EDA 数据不足”。

### 多步修改流程

EDA 面板中的普通问题和修改要求统一调用 `/v1/chat/stream`。模型可以直接回答、要求用户补充必要参数，也可以调用当前技能允许的写工具；写动态工具只会登记待确认 `ChangeSet`，并在同一轮结束后显示“确认执行”按钮，不要求用户预先回复“确认”或“登记”。服务会对“确认”“登记”“继续登记”等短跟进自动恢复布局技能和强化执行计划提示；App Server 的开发指令明确要求信息足够时直接调用动态写工具。旧 `legacy` Supervisor 还保留同轮纠偏逻辑。顶部“优先生成修改方案”只是同一流式接口的快捷入口；`/v1/plan` 仅为旧客户端保留。

两种入口都会实时显示阶段、推理、工具调用和 token 消耗。没有写操作是合法结果：说明类问题会正常完成，信息不足时模型会明确追问；只有实际生成了可执行操作，界面才显示确认入口。用户可点击任务卡片的“确认执行”，也可以在存在待确认任务时输入精确确认词“执行”或“确认执行”；两种方式都会调用 `/v1/tasks/:taskId/confirm`，服务会校验任务状态和 confirmation token，并在写入前重新读取项目和文档 ID，防止计划针对的设计已经变化。执行失败后，任务卡片可通过 `/v1/tasks/:taskId/retry` 直接克隆原始 `ChangeSet` 为带 `parentTaskId` 和递增 `attempt` 的新待确认任务；输入“重试”也会走同一路径，不再重新调用模型。若希望改变方案，应使用“重新规划”。当前真实原理图执行链支持移动/放置元件，以及创建导线、总线、矩形边框、多边形和文本；执行后统一调用 `easyeda_post_write_verify`。取消任务调用 `/v1/tasks/:taskId/cancel`。

测试接口：

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:49630/v1/chat `
  -ContentType "application/json" `
  -Body '{"sessionId":"demo","instruction":"请总结当前原理图，并指出可能需要检查的地方"}'
```

嘉立创EDA扩展从 `ws://127.0.0.1:49630/bridge` 主动连接 Agent 服务。当前已实现上下文、原理图元件、导线、DRC，以及实验性的原理图写工具：

- `easyeda_schematic_move_component`：移动元件并保持已有连接；
- `easyeda_library_search_devices`：按完整型号、关键词或立创 C 编号查询官方器件库；
- `easyeda_schematic_place_component`：使用查询得到的 `libraryUuid` 与器件 `uuid` 放置元件；
- `easyeda_schematic_create_wire` / `create_bus`：创建导线或总线折线；
- `easyeda_schematic_create_rectangle` / `create_polygon`：创建模块边框；
- `easyeda_schematic_create_text`：创建说明文本。

器件库搜索是只读工具；以上写工具都先形成 ChangeSet，确认后才执行。新增 create 类工具会校验当前文档和几何参数，并返回图元 ID 的异步读回状态；尚未进入通用事务框架，批量任务中的后续操作失败时不会自动删除前面已经创建的图元，因此真实工程使用前仍需截图、DRC/ERC 和人工复核。

移动元件工具不再调用实际环境中无法可靠更新既有复杂导线的 `SCH_PrimitiveWire.modify`。保持连接时，扩展保留全部原导线，按旧引脚到新引脚创建独立的水平/垂直桥接线，并使用原网络名辅助网络继承；任一桥接线创建失败时，会删除本轮已创建的桥接线并回滚元件。若创建调用已返回有效图元，但 EDA 的读取模型暂时看不到新线，则保留修改并返回 `connectionCheck=inconclusive`，交由紧随其后的 DRC/ERC 和截图复核，避免因读取缓存滞后误回滚。无法读取引脚、缺少 `SCH_PrimitiveWire.create/delete`，或没有找到任何与引脚匹配的导线端点时，则在移动前拒绝执行。确认元件原本未接线时，才可显式传入 `preserveConnections: false`。复杂总线和网络标签仍要求 DRC/ERC 与人工确认；写入必须显式传入 `confirmWrite: true`。

视觉验证工具使用嘉立创EDA的 `DMT_EditorControl`：先定位或缩放画布，再获取实际渲染区域 PNG。图片目前通过 Bridge JSON 的 Base64 内容块返回，便于支持视觉输入的模型直接查看；后续可替换成二进制帧或本地制品 URL。

嘉立创EDA扩展需要使用官方 `pro-api-sdk` 构建环境。本仓库适配器按本地安装的官方 `@jlceda/pro-api-types` 定义调用 `SCH_PrimitiveComponent`、`Wire`、`Bus`、`Rectangle`、`Polygon`、`Text`、选择控制和 DRC API；类型和夹具测试已覆盖，真实 API 的异步刷新、撤销栈和不同 EasyEDA Pro 版本行为仍需在扩展环境中验证。
