import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openExternalUrl, useRpc, useSettings, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { activity, changeShareUrl, connection, preferences, shareUrl } from "../shared/cnb";

export function ActivityPanel({ host, workspaceId, theme, navigation, projectId, repositoryId, share, canShare }: PluginWorkspacePanelProps & {
  projectId: string;
  repositoryId: string;
  share: string | null;
  canShare: boolean;
}) {
  const cache = useQueryClient();
  const settings = useSettings(preferences);
  const run = useRpc(activity);
  const saveLink = useRpc(changeShareUrl);
  const checkAccount = useRpc(connection);
  const [view, setView] = useState(false);
  const [draft, setDraft] = useState(share ?? "");
  const [linkError, setLinkError] = useState<string>();
  const config = settings.status === "ready" ? settings.values.automation[projectId] : undefined;
  const enabled = config?.repositoryId === repositoryId;
  const commentsEnabled = Boolean(enabled && config.commentsSince && config.commentsUsername);
  const backfillKey = ["cnb", host.id, "activity", projectId, repositoryId, enabled ? config.since : null, config?.commentsSince];
  const status = useQuery({
    queryKey: backfillKey,
    queryFn: () => run({ workspaceId, repositoryId, action: "status" }),
    enabled: settings.status === "ready" && view,
    refetchInterval: view && enabled ? 5_000 : false,
    retry: false,
  });
  const activityState = status.isSuccess ? status.data : undefined;
  const recentIds = activityState?.recent.map((entry) => entry.id).join(",");
  useEffect(() => {
    if (recentIds) {
      void cache.invalidateQueries({ queryKey: ["cnb", host.id, workspaceId, "detail"] });
    }
  }, [cache, host.id, workspaceId, recentIds]);

  const toggle = useMutation({
    async mutationFn(input: { setting: "sync" | "comments"; next: boolean }) {
      if (settings.status !== "ready") throw new Error("插件设置尚未就绪");
      const values = { ...settings.values.automation };
      const now = Date.now();
      if (input.setting === "sync") {
        if (input.next) values[projectId] = { repositoryId, since: now };
        else delete values[projectId];
      } else {
        if (!enabled) throw new Error("请先开启仓库动态同步");
        const username = input.next ? (await checkAccount({})).username : undefined;
        values[projectId] = { ...config, commentsSince: input.next ? now : undefined, commentsUsername: username };
      }
      const saved = await settings.save({ ...settings.values, automation: values }, settings.revision);
      if (!saved) throw new Error("未保存同步设置，请刷新后重试");
    },
  });
  const updateLink = useMutation({
    mutationFn: (url: string | null) => saveLink({ workspaceId, repositoryId, url }),
    async onSuccess(result) {
      setDraft(result.url ?? "");
      await cache.invalidateQueries({ queryKey: ["cnb", host.id, workspaceId, "context"] });
    },
  });
  const sync = useMutation({
    mutationFn: (action: "sync" | "retry") => run({ workspaceId, repositoryId, action }),
    onSuccess: (result) => cache.setQueryData(backfillKey, result),
  });
  const current = sync.isPending ? "同步中" : enabled ? "已开启" : "已关闭";
  const text = { color: theme.colors.foreground };
  const error = toggle.error?.message ?? updateLink.error?.message ?? sync.error?.message ?? status.error?.message ?? activityState?.error;
  const parsedLink = shareUrl.safeParse(draft.trim());
  const busy = toggle.isPending || settings.saving;
  return (
    <SettingsSection title="仓库动态">
      <SettingsCard>
        <SettingsAction label={current} actionLabel={view ? "收起动态" : "查看动态与回链设置"} onPress={() => setView(!view)} />
        {view && <>
          <SettingsSwitch label="自动同步" hint="Paseo 客户端与 daemon 连接时每分钟拉取，重新连接后从上次进度补拉"
            value={enabled} disabled={busy || settings.status !== "ready"}
            onValueChange={(next) => toggle.mutate({ setting: "sync", next })} />
          <SettingsSwitch label="自动评论回链" hint={commentsEnabled
            ? `以 ${config?.commentsUsername} 身份发送已确认可访问的工作区链接`
            : "授权使用当前 CNB CLI 账号向此仓库发送回链"}
            value={commentsEnabled} disabled={busy || !enabled}
            onValueChange={(next) => toggle.mutate({ setting: "comments", next })} />
          {canShare && <>
            <SettingsInput key={share ?? ""} label="工作区回链地址" initialValue={share ?? ""} placeholder="https://..."
              hint="请先让团队成员用自己的账号核对链接可访问" onChangeText={(value) => {
                setLinkError(undefined);
                setDraft(value);
              }} />
            {parsedLink.success && <SettingsAction label="链接检查" actionLabel="打开链接" onPress={() => {
              setLinkError(undefined);
              void openExternalUrl(parsedLink.data).catch((failure: unknown) => {
                setLinkError(failure instanceof Error ? failure.message : String(failure));
              });
            }} />}
            <SettingsAction label="允许发布到已启用回链的 CNB 仓库" actionLabel="确认可访问并保存"
              disabled={!parsedLink.success || updateLink.isPending || draft.trim() === share}
              onPress={() => { if (parsedLink.success) updateLink.mutate(parsedLink.data); }} />
            {share && <SettingsAction label="工作区链接" actionLabel="停用回链地址"
              disabled={updateLink.isPending} onPress={() => updateLink.mutate(null)} />}
            {linkError && <SettingsRow label="打开链接失败" error={linkError} />}
          </>}
          <SettingsAction label={activityState?.lastSync ? `上次同步 ${new Date(activityState.lastSync).toLocaleString()}` : "尚未同步"}
            actionLabel="立即同步" disabled={!enabled || sync.isPending}
            onPress={() => sync.mutate("sync")} />
          {activityState && <>
            <SettingsRow label="回链" hint={`待发送 ${activityState.comments.pending} · 待确认 ${activityState.comments.uncertain} · 已发送 ${activityState.comments.sent}`} />
            {activityState.nextHour !== null && <SettingsRow label="同步游标" hint={new Date(activityState.nextHour).toISOString()} />}
            {activityState.comments.uncertain > 0 && <SettingsAction label="上次发送结果待确认" actionLabel="核对并重试"
              disabled={!commentsEnabled || sync.isPending} onPress={() => sync.mutate("retry")} />}
          </>}
        </>}
      </SettingsCard>
      {error && <Text accessibilityRole="alert" style={text}>{error}</Text>}
      {view && activityState?.recent.length === 0 && <Text style={text}>尚无收到的 Issue、PR 或提交动态</Text>}
      {view && activityState?.recent.map((item) => (
        <View key={item.id} style={{ padding: 9, gap: 4, backgroundColor: theme.colors.surface1, borderRadius: 6 }}>
          <Text style={text}>{item.type} {item.target ? `#${item.target.number}` : ""}</Text>
          <Text style={{ color: theme.colors.foregroundMuted }}>{new Date(item.date).toLocaleString()} · {item.id}</Text>
          {!item.workspaces.length && <Text style={text}>未匹配工作区</Text>}
          {item.workspaces.map((workspace) => (
            <SettingsAction key={workspace.id} label={workspace.title} actionLabel="打开关联工作区" disabled={!navigation}
              onPress={() => navigation?.openWorkspace({ workspaceId: workspace.id })} />
          ))}
        </View>
      ))}
    </SettingsSection>
  );
}
