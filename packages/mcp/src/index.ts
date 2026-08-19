import type { EdaToolDefinition } from "../../contracts/src/index.ts";

const objectSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const JLCIRCUIT_TOOLS: EdaToolDefinition[] = [
  {
    name: "easyeda_health_check",
    description: "检查 JLCircuit Agent 与嘉立创EDA扩展之间的本地桥接状态。",
    riskLevel: "read",
    inputSchema: objectSchema,
    enabled: true,
  },
  {
    name: "easyeda_get_context",
    description: "读取当前项目、文档、选区以及原理图/PCB摘要。",
    riskLevel: "read",
    inputSchema: objectSchema,
    enabled: true,
  },
  {
    name: "easyeda_schematic_components",
    description: "读取当前原理图中的元件摘要和坐标。",
    riskLevel: "read",
    beta: true,
    inputSchema: objectSchema,
    enabled: true,
  },
  {
    name: "easyeda_schematic_wires",
    description: "读取当前原理图中的导线几何、网络和图元 ID。",
    riskLevel: "read",
    beta: true,
    inputSchema: objectSchema,
    enabled: true,
  },
  {
    name: "easyeda_run_drc",
    description: "运行当前文档的原生 DRC/ERC 检查。",
    riskLevel: "read",
    beta: true,
    inputSchema: objectSchema,
    enabled: true,
  },
  {
    name: "easyeda_canvas_locate",
    description: "将当前原理图或 PCB 画布定位到坐标或矩形区域。",
    riskLevel: "read",
    beta: true,
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        scaleRatio: { type: "number" },
        left: { type: "number" },
        right: { type: "number" },
        top: { type: "number" },
        bottom: { type: "number" },
        tabId: { type: "string" },
      },
    },
    enabled: true,
  },
  {
    name: "easyeda_canvas_capture",
    description: "截取当前嘉立创EDA画布渲染结果，返回 PNG 图片供 AI 或用户视觉检查。",
    riskLevel: "read",
    beta: true,
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" } },
    },
    enabled: true,
  },
  {
    name: "easyeda_canvas_capture_region",
    description: "定位到指定区域并截取画布图片，用于检查局部布局和连线可读性。",
    riskLevel: "read",
    beta: true,
    inputSchema: {
      type: "object",
      required: ["left", "right", "top", "bottom"],
      properties: {
        left: { type: "number" },
        right: { type: "number" },
        top: { type: "number" },
        bottom: { type: "number" },
        tabId: { type: "string" },
      },
    },
    enabled: true,
  },
  {
    name: "easyeda_post_write_verify",
    description: "执行写入后的上下文、DRC/ERC 和画布截图验证，返回语义证据与视觉证据。",
    riskLevel: "read",
    beta: true,
    inputSchema: {
      type: "object",
      properties: {
        left: { type: "number" },
        right: { type: "number" },
        top: { type: "number" },
        bottom: { type: "number" },
        tabId: { type: "string" },
        runDrc: { type: "boolean", default: true },
        capture: { type: "boolean", default: true },
      },
    },
    enabled: true,
  },
  {
    name: "easyeda_schematic_move_component",
    description: "移动原理图元件，并尝试保持连接导线端点；操作后返回连接校验结果。",
    riskLevel: "high",
    beta: true,
    inputSchema: {
      type: "object",
      required: ["primitiveId", "x", "y", "confirmWrite"],
      properties: {
        primitiveId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        preserveConnections: { type: "boolean", default: true },
        save: { type: "boolean", default: false },
        verifyVisual: { type: "boolean", default: true },
        tabId: { type: "string" },
        confirmWrite: { const: true },
      },
    },
    enabled: true,
  },
];

export const getTool = (name: string): EdaToolDefinition | undefined =>
  JLCIRCUIT_TOOLS.find((tool) => tool.name === name);
