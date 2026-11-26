import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CnbWorkspacePanel } from "./client/workspace";
import { CnbInboxEntry, CnbInboxScreen } from "./client/pull-inbox";
import { ConnectionSettings } from "./client/settings";
import { autoSync, cnbIssues } from "./shared/cnb";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "connection", title: "CNB 连接", icon: "KeyRound", Component: ConnectionSettings });
  client.addWorkspacePanel({
    id: "cnb",
    title: "CNB",
    icon: "GitPullRequest",
    locations: ["workspace", "explorer"],
    Component: CnbWorkspacePanel,
  });
  client.addAttachmentSource(cnbIssues);
  client.addScreen({ id: "inbox", title: "CNB 待办", Component: CnbInboxScreen });
  client.addSidebarHeaderItem({ id: "inbox", title: "CNB 待办", Component: CnbInboxEntry });
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await client.rpc(autoSync, {});
    } catch (error) {
      console.error("Better Paseo CNB: 自动同步请求失败", error);
    } finally {
      polling = false;
    }
  }
  // shortcut: the connected client ticks the poller, use a daemon startup hook for unattended sync.
  void poll();
  const timer = setInterval(() => { void poll(); }, 60_000);
  return () => clearInterval(timer);
}
