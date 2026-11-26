import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard } from "@getpaseo/plugin/client/ui";
import { workspaceContext } from "../shared/cnb";
import { createPull, currentPull } from "../shared/pulls";
import { PullError, PullInput } from "./pull-ui";

type Context = RpcOutput<typeof workspaceContext>;

export function CurrentPullPanel({ host, workspaceId, theme, repository, repositoryContext, open }: PluginWorkspacePanelProps & {
  repository: string;
  repositoryContext: Context;
  open: (id: string) => void;
}) {
  const read = useRpc(currentPull);
  const key = ["cnb", host.id, workspaceId] as const;
  const cache = useQueryClient();
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: [...key, "current-pull", repository],
    queryFn: () => read({ workspaceId, repository }),
    retry: false,
    refetchOnMount: "always",
  });
  const current = query.isSuccess ? query.data : undefined;
  const branch = current?.branch;
  return <View style={{ gap: 8 }}>
    <SettingsCard>
      <SettingsAction label={branch ? `当前分支 · ${branch}` : "当前分支 PR"}
        actionLabel={query.isFetching ? "读取中" : "刷新"} disabled={query.isFetching}
        onPress={() => { void query.refetch(); }} />
      {current?.pulls.map((pr) => <SettingsAction key={pr.number}
        label={`#${pr.number} ${pr.title}`} hint={`目标 ${pr.base.branch} · ${pr.state}`}
        actionLabel="查看 PR" onPress={() => open(pr.number)} />)}
      {current?.reviewSha && current.pulls[0]?.head.sha !== current.reviewSha &&
        <Text style={{ color: theme.colors.foregroundMuted, padding: 8 }}>
          此评审工作区检出 {current.reviewSha.slice(0, 12)}，PR 已有新提交。
        </Text>}
      {current?.canCreate && !current.pulls.length && branch && <SettingsAction
        label="当前分支暂无开启的 PR" actionLabel={creating ? "取消" : "新建 PR"}
        onPress={() => setCreating(!creating)} />}
    </SettingsCard>
    <PullError theme={theme} error={query.error?.message} />
    {current && !current.canCreate && !current.pulls.length && <Text style={{ color: theme.colors.foregroundMuted }}>
      切换到已配对 CNB 仓库的分支以查看或创建 PR。
    </Text>}
    {creating && current?.canCreate && !query.error && !current.pulls.length && branch &&
      <CreateForm key={branch} workspaceId={workspaceId} theme={theme} repository={repository}
        branch={branch} context={repositoryContext} issue={current.issue}
        onCreated={async (number) => {
          setCreating(false);
          await cache.invalidateQueries({ queryKey: key });
          open(number);
        }} />}
  </View>;
}

function CreateForm({ theme, workspaceId, repository, branch, context, issue, onCreated }: {
  theme: PluginWorkspacePanelProps["theme"];
  workspaceId: string;
  repository: string;
  branch: string;
  context: Context;
  issue: RpcOutput<typeof currentPull>["issue"];
  onCreated: (number: string) => Promise<void>;
}) {
  const create = useRpc(createPull);
  const [base, setBase] = useState(context.branches.find((name) => name !== branch && ["main", "master"].includes(name)) ?? "");
  const [title, setTitle] = useState((issue?.title || branch).slice(0, 255));
  const [body, setBody] = useState(issue ? `关联 Issue ${issue.url}\n\n` : "");
  const mutation = useMutation({
    mutationFn: () => create({ workspaceId, repository, branch, base: base.trim(), title, body }),
    onSuccess: (pr) => onCreated(pr.number),
  });
  return <View style={{ gap: 8 }}>
    <Text style={{ color: theme.colors.foregroundMuted }}>先用 Paseo 的 Git 面板把 {branch} 推送到 {repository}。</Text>
    <PullInput theme={theme} accessibilityLabel="目标分支" placeholder="目标分支，例如 main"
      value={base} maxLength={512} autoCapitalize="none" autoCorrect={false} onChangeText={setBase} />
    <PullInput theme={theme} accessibilityLabel="PR 标题" placeholder="PR 标题" value={title} maxLength={255} onChangeText={setTitle} />
    <PullInput theme={theme} accessibilityLabel="PR 描述" placeholder="PR 描述" multiline value={body} maxLength={20000} onChangeText={setBody} />
    <SettingsAction label={`${branch} → ${base.trim() || "目标分支"}`} actionLabel={mutation.isPending ? "正在创建" : "确认创建 PR"}
      disabled={mutation.isPending || !title.trim() || !base.trim() || base.trim() === branch}
      onPress={() => mutation.mutate()} />
    <PullError theme={theme} error={mutation.error?.message} />
  </View>;
}
