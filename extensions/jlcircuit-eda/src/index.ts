import { JlcEdaAdapter, type JlcEdaApi } from "./eda-adapter.ts";
import { EdaBridgeClient } from "./bridge-client.ts";

declare const eda: JlcEdaApi;

let bridgeClient: EdaBridgeClient | undefined;

const notify = (message: string, title = "JLCircuit Agent"): void => {
  try {
    if (eda.sys_Message?.showToastMessage) {
      eda.sys_Message.showToastMessage(message, "info");
      return;
    }
    eda.sys_Dialog?.showInformationMessage?.(message, title);
  } catch {
    // The host may expose neither notification API in older EDA versions.
  }
};

export async function connectAgentBridge(): Promise<void> {
  bridgeClient ??= new EdaBridgeClient(eda, {
    url: "ws://127.0.0.1:49630/bridge",
    extensionVersion: "0.3.0",
  });
  await bridgeClient.connect();
}

export async function openAssistantPanel(): Promise<void> {
  if (!eda.sys_IFrame?.openIFrame) {
    notify("当前 EasyEDA 运行时不提供 SYS_IFrame，无法打开智能助手界面。", "JLCircuit Agent");
    return;
  }

  const opened = await eda.sys_IFrame?.openIFrame?.(
    "/iframe/index.html",
    760,
    620,
    "jlcircuit-agent-assistant",
    {
      title: "JLCircuit Agent",
      maximizeButton: true,
      minimizeButton: true,
      minimizeStyle: "collapsed",
    },
  );

  if (opened === false) {
    notify("智能助手窗口打开失败，请检查扩展包是否包含 iframe/index.html。", "JLCircuit Agent");
    return;
  }

  try {
    await connectAgentBridge();
  } catch (error) {
    // The UI is still useful for local EDA inspection when the Agent service is offline.
    notify(`界面已打开，但 Agent 服务未连接：${String(error)}`, "JLCircuit Agent");
  }
}

export async function getCurrentContext() {
  return new JlcEdaAdapter(eda).getContext();
}

export async function runCurrentDocumentDrc() {
  return new JlcEdaAdapter(eda).runDrc();
}
