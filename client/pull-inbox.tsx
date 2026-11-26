import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl, useRpc, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Markdown, SettingsAction, SettingsCard, SettingsSelect, SidebarRow } from "@getpaseo/plugin/client/ui";
import { type connection, createIssueWorkspace, inboxIssue, newRequestId } from "../shared/cnb";
import { pullInbox, pullOverview } from "../shared/pulls";
import { CnbAccount } from "./settings";
import { PullDetail } from "./pull";
import { PullError } from "./pull-ui";

type Kind = RpcInput<typeof pullInbox>["kind"];
type SelectedIssue = RpcInput<typeof inboxIssue>;
type Selected = (SelectedIssue & { resource: "issues" }) | (RpcInput<typeof pullOverview> & { resource: "pulls" });
const filters = [
  { value: "issues", label: "全部开放 Issue" },
  { value: "review", label: "待我评审" },
  { value: "authored", label: "我创建的 PR" },
  { value: "assigned", label: "分配给我的 Issue" },
] as const;

export function CnbInboxEntry({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Inbox" active={currentScreen?.screenId === "inbox"}
    onPress={() => openScreen({ screenId: "inbox" })} />;
}

export function CnbInboxScreen(props: PluginScreenProps) {
  return <CnbAccount hostId={props.host.id} theme={props.theme}><Inbox {...props} /></CnbAccount>;
}

function Inbox(props: PluginScreenProps) {
  const { theme, host, navigation } = props;
  const cache = useQueryClient();
  const read = useRpc(pullInbox);
  const [kind, setKind] = useState<Kind>("issues");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [externalError, setExternalError] = useState("");
  const query = useQuery({
    queryKey: ["cnb", host.id, "inbox", kind, page],
    queryFn: () => read({ kind, page }),
    enabled: !selected,
    retry: false,
  });
  const username = cache.getQueryData<RpcOutput<typeof connection>>(["cnb", host.id, "connection"])?.username;
  const changedAccount = query.isSuccess && query.data.username !== username;
  useEffect(() => {
    if (changedAccount || query.error) {
      void cache.invalidateQueries({ queryKey: ["cnb", host.id, "connection"], exact: true }, { cancelRefetch: false });
    }
  }, [cache, host.id, changedAccount, query.error]);
  const inbox = query.isSuccess && !changedAccount ? query.data : undefined;
  const foreground = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const empty = kind === "issues" ? "本页没有开放 Issue。"
    : kind === "assigned" ? "本页没有分配给你的开放 Issue。" : "本页无待办。";
  return <ScrollView style={{ backgroundColor: theme.colors.surface0 }}
    contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 880, width: "100%", alignSelf: "center" }}>
    <Text accessibilityRole="header" style={{ ...foreground, fontSize: 20, fontWeight: "600" }}>CNB 待办</Text>
    {selected ? <>
      <SettingsAction label={`${selected.repository} #${selected.number}`} actionLabel="返回待办" onPress={() => setSelected(null)} />
      {selected.resource === "pulls" ? <PullDetail {...props} target={selected} /> : <InboxIssue {...props} selection={selected} />}
    </> : <>
      <SettingsSelect label="筛选" value={kind} options={filters} onValueChange={(kind) => { setKind(kind); setPage(1); setExternalError(""); }} />
      <SettingsAction label={inbox ? `${inbox.username} · 第 ${page} 页` : "项目仓库"}
        actionLabel={query.isFetching ? "读取中" : "刷新"} disabled={query.isFetching}
        onPress={() => { void query.refetch(); }} />
      <PullError theme={theme} error={query.error?.message ?? externalError} />
      {inbox?.repositories.length === 0 && inbox.discoveryIssues.length === 0 &&
        <Text style={muted}>Paseo 项目中未发现 CNB 仓库。可在工作区配置 Git remote 或在 CNB 面板填写仓库链接。</Text>}
      {inbox?.discoveryIssues.map((project) => <View key={project.projectId} style={{ gap: 4 }}>
        <Text style={foreground}>{project.title}</Text>
        <PullError theme={theme} error={project.error} />
        {project.workspaceId && navigation && <SettingsAction label="工作区" actionLabel="打开"
          onPress={() => { if (project.workspaceId) navigation.openWorkspace({ workspaceId: project.workspaceId }); }} />}
      </View>)}
      {inbox?.repositories.map((repo) => <View key={repo.path} style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={{ ...muted, fontWeight: "600" }}>{repo.path}</Text>
        <PullError theme={theme} error={repo.error} />
        {!repo.error && !repo.items.length && <Text style={muted}>{empty}</Text>}
        {repo.items.length > 0 && <SettingsCard>
          {repo.items.map((item) => <SettingsAction key={item.number} label={`#${item.number} ${item.title}`}
            hint={item.state} actionLabel={item.resource === "issues" || repo.workspaceId ? "查看详情" : "在 CNB 打开"}
            onPress={() => {
              setExternalError("");
              const target = { repository: repo.path, number: item.number };
              if (item.resource === "issues") {
                setSelected({ ...target, projectId: repo.projectId, resource: "issues" });
              } else if (repo.workspaceId) {
                setSelected({ ...target, workspaceId: repo.workspaceId, resource: "pulls" });
              } else {
                void openExternalUrl(item.url).catch((error: unknown) => setExternalError(String(error)));
              }
            }} />)}
        </SettingsCard>}
      </View>)}
      {page > 1 && <SettingsAction label="分页" actionLabel="上一页" onPress={() => setPage(page - 1)} />}
      {inbox?.repositories.some((repo) => repo.more) &&
        <SettingsAction label="分页" actionLabel="下一页" onPress={() => setPage(page + 1)} />}
    </>}
  </ScrollView>;
}

function InboxIssue({ host, theme, selection, navigation }: PluginScreenProps & { selection: SelectedIssue }) {
  const read = useRpc(inboxIssue);
  const create = useRpc(createIssueWorkspace);
  const cache = useQueryClient();
  const [error, setError] = useState("");
  const [selectedBase, setSelectedBase] = useState<string>();
  const [requestId, setRequestId] = useState(newRequestId);
  const { projectId, number, repository } = selection;
  const queryKey = ["cnb", host.id, "inbox-issue", projectId, repository, number];
  const query = useQuery({
    queryKey,
    queryFn: () => read({ projectId, number, repository }),
    retry: false,
  });
  const issue = query.data;
  const base = selectedBase ?? issue?.base ?? "";
  const launch = useMutation({
    mutationFn: async () => {
      if (!issue || !issue.branches.includes(base)) throw new Error("请选择可用的基准分支");
      return create({ projectId, number, repository, repositoryId: issue.repositoryId, base, requestId });
    },
    onSuccess: ({ workspace }) => {
      setRequestId(newRequestId());
      cache.setQueryData<RpcOutput<typeof inboxIssue>>(queryKey, (previous) => previous && { ...previous, workspace });
      navigation?.openWorkspace({ workspaceId: workspace.id });
    },
  });
  const text = { color: theme.colors.foreground };
  return <>
    {query.isFetching && <Text style={text}>正在加载 Issue</Text>}
    <PullError theme={theme} error={query.error?.message} retry={() => { void query.refetch(); }} />
    <PullError theme={theme} error={error} />
    {issue && !query.error && <>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600", fontSize: 16 }}>{issue.title}</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>#{issue.number} · {issue.state === "open" ? "开放" : issue.state}</Text>
      {issue.body ? <Markdown>{issue.body}</Markdown> : <Text style={text}>暂无正文</Text>}
      <SettingsAction label={repository} actionLabel="在 CNB 打开"
        onPress={() => { void openExternalUrl(issue.url).catch((error: unknown) => setError(String(error))); }} />
      {issue.workspace ? <SettingsAction label={issue.workspace.title} actionLabel="打开关联工作区"
        disabled={!navigation} onPress={() => { if (issue.workspace) navigation?.openWorkspace({ workspaceId: issue.workspace.id }); }} />
        : issue.branches.length > 0 && <SettingsCard>
          <SettingsSelect label="基准分支" value={base} onValueChange={(next) => {
            setSelectedBase(next);
            setRequestId(newRequestId());
          }} disabled={launch.isPending}
            options={[{ value: "", label: "选择分支" }, ...issue.branches.map((branch) => ({ value: branch, label: branch }))]} />
          <SettingsAction label="从此 Issue 开工" actionLabel={launch.isPending ? "创建中" : "新建工作区"}
            disabled={query.isFetching || launch.isPending || !issue.branches.includes(base)} onPress={() => launch.mutate()} />
        </SettingsCard>}
      <PullError theme={theme} error={issue.workspaceError} retry={() => { void query.refetch(); }} />
      <PullError theme={theme} error={launch.error?.message} />
    </>}
  </>;
}
