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
- `packages/contracts`：前后端共享的 Design IR、ChangeSet 和消息协议。
- `packages/bridge`：面向 EDA 执行端的类型化能力边界。
- `extensions/jlcircuit-eda`：嘉立创EDA扩展入口、助手面板和 API 适配器。
- `docs/architecture.md`：当前架构决策和 MVP 边界。

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
extensions/jlcircuit-eda/build/dist/jlcircuit-agent_v0.1.4.eext
```

在嘉立创EDA专业版 V3 中选择“高级 → 扩展管理器 → 导入”，导入上面的 `.eext` 文件；V2 可从“设置 → 扩展 → 扩展管理器 → 导入扩展”进入。扩展需要开启 External Interaction 权限，运行时通过官方 `eda.sys_WebSocket` 连接本地 Agent 服务。

服务默认监听 `http://127.0.0.1:49630`，健康检查：

```text
GET /health
```

工具入口：

```text
GET  /v1/tools
POST /v1/tools/:toolName
POST /v1/context
POST /v1/drc
POST /v1/chat
POST /v1/plan
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
