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
extensions/jlcircuit-eda/build/dist/jlcircuit-agent_v0.3.0.eext
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
GET  /v1/tasks/:taskId
POST /v1/tasks/:taskId/confirm
POST /v1/tasks/:taskId/cancel
POST /v1/tools/easyeda_canvas_locate
POST /v1/tools/easyeda_canvas_capture
POST /v1/tools/easyeda_canvas_capture_region
POST /v1/tools/easyeda_post_write_verify
WS   ws://127.0.0.1:49630/bridge
```

## 接入大语言模型

Agent 服务支持 OpenAI-compatible Chat Completions 接口，默认不配置模型时使用 `stub`，不会发起外部请求。复制 `.env.example` 为本地环境配置，并设置模型提供方、接口地址、密钥和模型名：

```powershell
$envFile = ".env"
Copy-Item .env.example $envFile

$env:JLCIRCUIT_MODEL_PROVIDER="deepseek"
$env:JLCIRCUIT_LLM_BASE_URL="https://api.deepseek.com/v1"
$env:JLCIRCUIT_LLM_API_KEY="你的API密钥"
$env:JLCIRCUIT_LLM_MODEL="deepseek-chat"
npm run dev
```

也可以直接编辑项目根目录的 `.env`；`npm run dev` 会自动加载它。`.env` 已被 Git 忽略，不应提交 API 密钥。

也可以把 `JLCIRCUIT_MODEL_PROVIDER` 设置为 `openai`，并使用 `https://api.openai.com/v1` 和对应模型。模型回合会先读取当前 EDA 上下文，再按需调用只读工具；高风险写工具不会在模型回合中自动执行。

### 图像识别模型路由

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
JLCIRCUIT_LLM_REASONING_EFFORT=low
JLCIRCUIT_LLM_FINAL_REASONING_EFFORT=minimal
JLCIRCUIT_LLM_MAX_LENGTH_RECOVERIES=1
JLCIRCUIT_LLM_CONTEXT_MAX_CHARS=40000
JLCIRCUIT_LLM_CONTEXT_MAX_ITEMS=200
JLCIRCUIT_AGENT_MAX_TOOL_CALLS=40
JLCIRCUIT_AGENT_MAX_ELAPSED_MS=300000
JLCIRCUIT_AGENT_MAX_NO_PROGRESS=2
JLCIRCUIT_AGENT_MAX_RETRIES_PER_ACTION=2
JLCIRCUIT_AGENT_FINALIZE_TIMEOUT_MS=60000
```

视觉模型的地址和密钥可以省略，此时复用 `JLCIRCUIT_LLM_BASE_URL` 和 `JLCIRCUIT_LLM_API_KEY`，只替换模型名即可。配置的地址既可以是 `https://provider.example/v1`，也可以直接带 `/chat/completions`；服务会自动规范化，避免重复拼接路径。

模型调用画布截图时会先保留结构化工具结果，再追加一条包含 PNG Base64 的视觉消息，并要求模型检查元件/网络标签、断线悬空、文字碰撞、拥挤和不合理交叉。没有截图时仍只调用当前语言模型。

`JLCIRCUIT_LLM_MAX_TOKENS` 限制单次模型输出（包括 reasoning）长度；`JLCIRCUIT_LLM_CONTEXT_MAX_CHARS` 限制发送给模型的设计上下文字符数；`JLCIRCUIT_LLM_CONTEXT_MAX_ITEMS` 限制元件和导线样例数量。服务会保留总数和截断标记，Agent 返回的原始上下文不受影响。

默认启用端到端流式输出：Agent Service 使用 OpenAI-compatible SSE 读取模型的 `content`、`reasoning`、流式工具调用和最终 usage，再通过 `POST /v1/chat/stream` 把运行事件转发给 EDA 面板。面板在执行时显示阶段、耗时、模型请求数、工具调用数、推理过程及 token；精确 usage 到达前显示根据字符数计算的近似生成量，收到供应商最终 usage 后切换为输入/输出/推理/总 token。执行结束后推理区域自动折叠，最终答案保持展开。

Reasoning token 计入输出预算。若模型以 `finish_reason=length` 结束，服务会保留已有推理和工具结果，禁用工具并自动追加一次低 reasoning 的最终总结请求；`JLCIRCUIT_LLM_MAX_LENGTH_RECOVERIES` 控制这种恢复次数。对于 OpenRouter reasoning 模型，可通过 `JLCIRCUIT_LLM_REASONING_EFFORT=low` 给正文保留更多输出空间，最终总结单独使用 `JLCIRCUIT_LLM_FINAL_REASONING_EFFORT=minimal`。不支持 `reasoning.effort` 的供应商应留空这两个配置。

Agent 不再按固定模型请求轮数停止，而是持续执行到模型给出结果、需要用户补充信息、需要确认写操作或工具明确阻塞。`JLCIRCUIT_AGENT_MAX_TOOL_CALLS` 和 `JLCIRCUIT_AGENT_MAX_ELAPSED_MS` 是防止失控的总预算；`JLCIRCUIT_AGENT_MAX_NO_PROGRESS` 用来触发一次换策略恢复，`JLCIRCUIT_AGENT_MAX_RETRIES_PER_ACTION` 阻止相同工具和参数无限重复。预算耗尽时，服务会禁用工具并额外请求一次阶段总结，返回已完成内容、证据、缺口和可恢复检查点。`JLCIRCUIT_AGENT_FINALIZE_TIMEOUT_MS` 单独控制这次总结请求。旧的 `JLCIRCUIT_LLM_MAX_TOOL_ROUNDS` 已不再使用。

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

自动模式会启用 always 技能，并按用户指令关键字选择专用技能。模型只会看到这些技能联合允许的工具；Chat 模式仍禁止写入，Plan 模式仍只产生待确认 ChangeSet。技能启停状态保存在 SQLite。技能入口必须留在自身目录内，未知工具、重复 ID、越界入口和过大的说明文件会被拒绝。当前技能是声明和提示词，不会执行技能目录中的任意脚本；外部 MCP 工具由下述 MCP 插件网关独立加载和约束。

`POST /v1/chat` 和 `POST /v1/plan` 可传 `skillIds` 数组明确选择技能；省略时自动选择：

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

当前版本的“生成修改计划”会调用 `/v1/plan`，只生成待确认的 `ChangeSet`，不会直接写入 EDA。计划模式允许模型直接回答或追问：普通说明会正常完成，只有确实缺少关键输入时才进入 `awaiting_user`，不会因为没有写操作就自动重试。用户可以继续输入补充信息，或点击界面上的“强制生成执行计划”要求模型再次尝试生成结构化写操作。生成写操作后，用户确认时调用 `/v1/tasks/:taskId/confirm`，服务会在写入前重新读取项目和文档 ID，防止计划针对的设计已经变化；当前第一条真实执行链只支持 `easyeda_schematic_move_component`，执行后自动调用 `easyeda_post_write_verify`。取消计划调用 `/v1/tasks/:taskId/cancel`。

测试接口：

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:49630/v1/chat `
  -ContentType "application/json" `
  -Body '{"sessionId":"demo","instruction":"请总结当前原理图，并指出可能需要检查的地方"}'
```

嘉立创EDA扩展从 `ws://127.0.0.1:49630/bridge` 主动连接 Agent 服务。当前已实现上下文、原理图元件、导线、DRC，以及实验性的 `easyeda_schematic_move_component`。

移动元件工具只对可识别的引脚导线端点做补偿，复杂分支、总线和网络标签仍要求 DRC/ERC 与人工确认；写入必须显式传入 `confirmWrite: true`。

视觉验证工具使用嘉立创EDA的 `DMT_EditorControl`：先定位或缩放画布，再获取实际渲染区域 PNG。图片目前通过 Bridge JSON 的 Base64 内容块返回，便于支持视觉输入的模型直接查看；后续可替换成二进制帧或本地制品 URL。

嘉立创EDA扩展需要使用官方 `pro-api-sdk` 构建环境。本仓库的适配器已经按官方 `SCH_PrimitiveComponent`、`SCH_PrimitiveWire`、选择控制和 DRC API 预留接口，但真实 API 类型和运行时行为仍需在 EasyEDA Pro 扩展环境中验证。
