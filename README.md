# JLCircuit Agent

嘉立创智能电路助手的初始工程骨架。

项目采用“本地嘉立创EDA扩展负责执行，后端 Agent 负责理解与编排”的结构。当前实现参考 `easyeda-mcp-pro`，先提供本地 MCP 风格工具层和 WebSocket Bridge：

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
extensions/jlcircuit-eda/build/dist/jlcircuit-agent_v0.2.0.eext
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
POST /v1/mcp/reload
POST /v1/mcp/servers/:serverId/enable
POST /v1/mcp/servers/:serverId/disable
POST /v1/mcp/servers/:serverId/connect
POST /v1/mcp/servers/:serverId/disconnect
GET  /v1/mcp/servers/:serverId/resources
POST /v1/mcp/servers/:serverId/resources/read
GET  /v1/mcp/servers/:serverId/prompts
POST /v1/mcp/servers/:serverId/prompts/get
POST /v1/tools/:toolName
POST /v1/sessions
GET  /v1/sessions/:sessionId
GET  /v1/sessions/:sessionId/audit
POST /v1/sessions/:sessionId/clear
POST /v1/context
POST /v1/drc
POST /v1/chat
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
JLCIRCUIT_LLM_MAX_TOKENS=1024
JLCIRCUIT_LLM_CONTEXT_MAX_CHARS=40000
JLCIRCUIT_LLM_CONTEXT_MAX_ITEMS=200
```

视觉模型的地址和密钥可以省略，此时复用 `JLCIRCUIT_LLM_BASE_URL` 和 `JLCIRCUIT_LLM_API_KEY`，只替换模型名即可。配置的地址既可以是 `https://provider.example/v1`，也可以直接带 `/chat/completions`；服务会自动规范化，避免重复拼接路径。

模型调用画布截图时会先保留结构化工具结果，再追加一条包含 PNG Base64 的视觉消息，并要求模型检查元件/网络标签、断线悬空、文字碰撞、拥挤和不合理交叉。没有截图时仍只调用当前语言模型。

`JLCIRCUIT_LLM_MAX_TOKENS` 限制单次模型输出（包括 reasoning）长度；`JLCIRCUIT_LLM_CONTEXT_MAX_CHARS` 限制发送给模型的设计上下文字符数；`JLCIRCUIT_LLM_CONTEXT_MAX_ITEMS` 限制元件和导线样例数量。服务会保留总数和截断标记，Agent 返回的原始上下文不受影响。

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

服务启动时会加载 `skills/builtin/*/skill.json`，并可通过 `JLCIRCUIT_SKILL_ROOTS` 加载额外的受信目录。每个技能由 `skill.json` 和同目录内的 `SKILL.md` 组成，声明启用条件、适用模式、允许/必需工具和风险级别。当前内置 `eda-core` 与 `schematic-layout`；面板可选择“自动”或明确指定一个技能。

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
Invoke-RestMethod -Method Post http://127.0.0.1:49630/v1/mcp/reload
Invoke-RestMethod -Method Post http://127.0.0.1:49630/v1/mcp/servers/local-example/enable
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

EDA 面板顶部显示 MCP 已连接数量，“插件状态”按钮可查看每个 Server 的状态及能力计数。当前没有插件商店、OAuth 交互授权、自动安装、失败重连或外部写操作执行器。

### 多步修改流程

当前版本的“生成修改计划”会调用 `/v1/plan`，只生成待确认的 `ChangeSet`，不会直接写入 EDA。计划模式允许模型直接回答或追问；如果没有写操作，任务会进入 `awaiting_user` 状态，不会被当成失败，也不会自动重试。用户可以继续输入补充信息，或点击界面上的“强制生成执行计划”要求模型再次尝试生成结构化写操作。生成写操作后，用户确认时调用 `/v1/tasks/:taskId/confirm`，服务会在写入前重新读取项目和文档 ID，防止计划针对的设计已经变化；当前第一条真实执行链只支持 `easyeda_schematic_move_component`，执行后自动调用 `easyeda_post_write_verify`。取消计划调用 `/v1/tasks/:taskId/cancel`。

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
