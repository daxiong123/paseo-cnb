import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl, usePaseo, useRpc, useSettings, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Markdown, SettingsAction, SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { getItem, inspectRepository, issueAction, listItems, newRequestId, number, preferences, slug, workspaceContext } from "../shared/cnb";
import { ActivityPanel } from "./activity";
import { CurrentPullPanel } from "./current-pull";
import { CnbAccount } from "./settings";
import { PullDetail } from "./pull";

type Context = RpcOutput<typeof workspaceContext>;
type Item = RpcOutput<typeof getItem>;
type Panel = PluginWorkspacePanelProps;
type Resource = "issues" | "pulls";

export function CnbWorkspacePanel(props: Panel) {
  const { host, theme, workspaceId } = props;
  const readContext = useRpc(workspaceContext);
  const inspect = useRpc(inspectRepository);
  const run = useRpc(issueAction);
  const settings = useSettings(preferences);
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const context = useQuery({
    queryKey: ["cnb", host.id, workspaceId, "context"],
    queryFn: () => readContext({ workspaceId }),
    retry: false,
  });
  const projectId = context.data?.projectId;
  const repo = context.data?.repository;
  const manual = projectId && settings.status === "ready" && Boolean(settings.values.projects[projectId]);
  const currentIssue = context.data?.issue;
  const staleIssue = currentIssue && !context.data?.repositoryError && currentIssue.repositoryId !== repo?.id ? currentIssue : null;
  const unlink = useMutation({
    mutationFn: (issue: NonNullable<Context["issue"]>) => run({
      action: "unlink", workspaceId, number: issue.number, repositoryId: issue.repositoryId,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cnb", host.id, workspaceId] }),
  });
  const pair = useMutation({
    async mutationFn(address: string | null) {
      if (!projectId || settings.status !== "ready") throw new Error("工作区或插件设置尚未就绪");
      const projects = { ...settings.values.projects };
      if (address === null) {
        delete projects[projectId];
      } else {
        if (repo && context.data?.issue) throw new Error("请先解除当前工作区的 Issue 关联");
        projects[projectId] = await inspect({ workspaceId, url: address });
      }
      const saved = await settings.save({ ...settings.values, projects }, settings.revision);
      if (!saved) throw new Error("未保存仓库配对。请查看设置错误或刷新后重试");
      await queryClient.invalidateQueries({ queryKey: ["cnb", host.id] });
      setUrl("");
    },
  });
  const error = context.error?.message
    ?? (settings.status === "invalid" || settings.status === "error" ? settings.error : null)
    ?? settings.saveError ?? pair.error?.message ?? unlink.error?.message ?? context.data?.repositoryError;
  const busy = pair.isPending || settings.saving;
  const text = { color: theme.colors.foreground };
  return (
    <ScrollView style={{ backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      {error && <Text accessibilityRole="alert" style={text}>{error}</Text>}
      {context.isFetching && <Text style={text}>正在读取工作区</Text>}
      {context.error && <SettingsAction label="工作区" actionLabel="重试" onPress={() => { void context.refetch(); }} />}
      {context.isSuccess && settings.status === "ready" && (
        <>
          <SettingsAction label={repo ? `${manual ? "已选择" : "从 Git 识别"} · ${repo.path}`
            : context.data.remotes.length === 1 ? `Git 远端 · ${context.data.remotes[0]}` : "CNB 仓库"}
            actionLabel="重新读取" disabled={context.isFetching}
            onPress={() => { void queryClient.invalidateQueries({ queryKey: ["cnb", host.id, workspaceId] }); }} />
          {manual && <SettingsAction label="项目仓库" actionLabel="恢复从 Git 识别" disabled={busy}
            onPress={() => pair.mutate(null)} />}
          {!repo && context.data.remotes.length > 1 && !context.data.repositoryError &&
            <Text style={text}>项目有多个 CNB 远端，请选择这个项目要使用的仓库。</Text>}
          {staleIssue && <SettingsAction label={`${staleIssue.path}#${staleIssue.number} 已脱离当前仓库配对`}
            actionLabel="解除旧关联" disabled={unlink.isPending} onPress={() => unlink.mutate(staleIssue)} />}
          {!repo && context.data.remotes.length > 1 && context.data.remotes.map((remote) => (
            <SettingsAction key={remote} label={remote} actionLabel="选择" disabled={busy}
              onPress={() => pair.mutate(`https://cnb.cool/${remote}`)} />
          ))}
          {(!repo || !context.data.issue) && (
            <View style={{ gap: 8 }}>
              <TextInput
                style={{ ...text, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, padding: 8 }}
                placeholderTextColor={theme.colors.foregroundMuted}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="CNB 仓库链接"
                placeholder="https://cnb.cool/组织/仓库"
                value={url}
                onChangeText={setUrl}
              />
              <SettingsAction label={repo ? "选择其他仓库" : "仓库链接"} actionLabel={busy ? "校验中" : "校验并选择"}
                disabled={busy || !url.trim()} onPress={() => pair.mutate(url.trim())} />
            </View>
          )}
          {repo && <CnbAccount hostId={host.id} theme={theme}>
            <RepositoryPanel key={repo.id} {...props} repository={repo.path} repositoryId={repo.id}
              repositoryContext={context.data} staleIssue={Boolean(staleIssue)} />
            <ActivityPanel key={`activity:${repo.id}`} {...props} projectId={context.data.projectId}
              repositoryId={repo.id} share={context.data.shareUrl} canShare={Boolean(currentIssue && !staleIssue)} />
          </CnbAccount>}
        </>
      )}
    </ScrollView>
  );
}

function RepositoryPanel({ repositoryContext: context, repository, repositoryId, staleIssue, ...props }: Panel & {
  repositoryContext: Context;
  repository: string;
  repositoryId: string;
  staleIssue: boolean;
}) {
  const { host, workspaceId, theme } = props;
  const list = useRpc(listItems);
  const readItem = useRpc(getItem);
  const [resource, setResource] = useState<Resource>("issues");
  const [search, setSearch] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [searchError, setSearchError] = useState("");
  const exactNumber = number.safeParse(search.trim().replace(/^#/, ""));
  const reference = /^https:\/\/cnb\.cool\/(.+)\/-\/pulls\/([1-9]\d{0,19})\/?(?:[?#][^\s]*)?$/.exec(search.trim());
  const hasPullLink = Boolean(reference && slug.safeParse(reference[1]).success);
  const listQuery = useQuery({
    queryKey: ["cnb", host.id, workspaceId, "list", resource, page, keyword, repositoryId],
    queryFn: () => list({ workspaceId, repository, resource, page, keyword: resource === "issues" ? keyword : "" }),
    enabled: !selected,
    retry: false,
  });
  const detail = useQuery({
    queryKey: ["cnb", host.id, workspaceId, "detail", resource, selected, repositoryId],
    queryFn: () => readItem({ workspaceId, repository, resource: "issues", number: number.parse(selected) }),
    enabled: selected !== null && resource === "issues",
    retry: false,
  });
  const rows = listQuery.isSuccess ? listQuery.data.items.filter((item) => resource === "issues" ||
    item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : [];
  const text = { color: theme.colors.foreground };
  function changeTab(tab: Resource) {
    setResource(tab);
    setPage(1);
    setSearch("");
    setKeyword("");
    setSelected(null);
    setSearchError("");
  }
  function openPull(id: string) {
    changeTab("pulls");
    setSelected(id);
  }
  function runSearch() {
    setSearchError("");
    if (exactNumber.success) setSelected(exactNumber.data);
    else if (resource === "pulls" && reference && hasPullLink) {
      if (reference[1] === repository) openPull(reference[2]);
      else setSearchError("此 PR 属于其他仓库，请在对应的工作区打开");
    } else if (resource === "issues") {
      setPage(1);
      setKeyword(search.trim());
    }
  }
  return (
    <View style={{ gap: 10 }}>
      <SettingsCard>
        <SettingsSelect<Resource> label="资源" value={resource} onValueChange={changeTab}
          options={[{ value: "issues", label: "Issue" }, { value: "pulls", label: "PR" }]} />
        {context.issue && !staleIssue && (
          <SettingsAction label="当前工作区的 Issue" actionLabel={`#${context.issue.number}`}
            onPress={() => { changeTab("issues"); setSelected(context.issue?.number ?? null); }} />
        )}
      </SettingsCard>
      {selected === null ? (
        <>
          <CurrentPullPanel {...props} repository={repository} repositoryContext={context} open={openPull} />
          <TextInput style={{ ...text, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, padding: 8 }}
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel={resource === "issues" ? "搜索 Issue" : "过滤 PR"}
            placeholder={resource === "issues" ? "Issue 编号或关键词" : "PR 编号、链接或当前页标题"}
            value={search}
            onChangeText={(search) => { setSearch(search); setSearchError(""); }}
            onSubmitEditing={runSearch}
          />
          {searchError && <Text accessibilityRole="alert" style={text}>{searchError}</Text>}
          {exactNumber.success ? (
            <SettingsAction label="按编号查找" actionLabel={`打开 #${exactNumber.data}`}
              onPress={runSearch} />
          ) : resource === "pulls" && hasPullLink ? (
            <SettingsAction label="从链接打开 PR" actionLabel="查看 PR" onPress={runSearch} />
          ) : resource === "issues" && (
            <SettingsAction label="搜索 Issue" actionLabel="搜索" onPress={runSearch} />
          )}
          <SettingsAction label={`第 ${page} 页`} actionLabel="刷新" disabled={listQuery.isFetching}
            onPress={() => { void listQuery.refetch(); }} />
          {listQuery.isFetching && <Text style={text}>正在加载</Text>}
          {listQuery.error && <Text accessibilityRole="alert" style={text}>{listQuery.error.message}</Text>}
          {listQuery.isSuccess && rows.length === 0 && <Text style={text}>当前页没有匹配结果</Text>}
          {rows.map((item) => (
            <Pressable key={item.number} accessibilityRole="button" accessibilityLabel={`#${item.number} ${item.title}`}
              onPress={() => setSelected(item.number)}
              style={{ backgroundColor: theme.colors.surface1, borderRadius: 6, padding: 10, gap: 4 }}>
              <Text style={text}>{item.title}</Text>
              <Text style={{ color: theme.colors.foregroundMuted }}>#{item.number} · {item.state}</Text>
            </Pressable>
          ))}
          {(page > 1 || listQuery.data?.more) && <SettingsCard>
            {page > 1 && <SettingsAction label="分页" actionLabel="上一页" onPress={() => setPage(page - 1)} />}
            {listQuery.data?.more && <SettingsAction label="分页" actionLabel="下一页" onPress={() => setPage(page + 1)} />}
          </SettingsCard>}
        </>
      ) : (
        <>
          <SettingsAction label={`#${selected}`} actionLabel="返回列表" onPress={() => setSelected(null)} />
          {detail.isFetching && <Text style={text}>正在加载详情</Text>}
          {detail.error && <>
            <Text accessibilityRole="alert" style={text}>{detail.error.message}</Text>
            <SettingsAction label="详情" actionLabel="重试" onPress={() => { void detail.refetch(); }} />
          </>}
          {detail.isSuccess && resource === "issues" && <ItemDetail key={selected} {...props}
            repositoryContext={context} repositoryId={repositoryId} item={detail.data} />}
          {resource === "pulls" && <PullDetail key={selected} {...props}
            target={{ workspaceId, repository, number: selected }} />}
        </>
      )}
    </View>
  );
}

function ItemDetail({ item, repositoryContext: context, repositoryId, host, workspaceId, navigation, theme }: Panel & {
  item: Item;
  repositoryId: string;
  repositoryContext: Context;
}) {
  const run = useRpc(issueAction);
  const paseo = usePaseo();
  const cache = useQueryClient();
  const [externalError, setExternalError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [base, setBase] = useState(context.branch ?? "");
  const [provider, setProvider] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);
  const providers = useQuery({
    queryKey: ["cnb", host.id, "provider-options"],
    queryFn: () => paseo.providers.snapshot(),
    enabled: preparing,
    retry: false,
  });
  const options = providers.data?.entries.flatMap((entry) => entry.enabled
    ? (entry.models ?? []).filter((model) => model.isSelectable !== false).map((model) => ({
      value: `${entry.provider}/${model.id}`, label: `${entry.label ?? entry.provider} · ${model.label}`,
    })) : []) ?? [];
  const action = useMutation({
    mutationFn: (action: "link" | "unlink" | "start") => {
      const input = { workspaceId, number: item.number, repositoryId };
      if (action === "start") return run({ ...input, action, base, provider, requestId });
      if (action === "link") return run({ ...input, action });
      if (!context.issue) throw new Error("当前工作区的 Issue 关联已更新，请刷新后重试");
      return run({ ...input, action, repositoryId: context.issue.repositoryId });
    },
    onSuccess: () => setRequestId(newRequestId()),
    onSettled: async () => {
      await cache.invalidateQueries({ queryKey: ["cnb", host.id, workspaceId, "detail", "issues", item.number] });
      await cache.invalidateQueries({ queryKey: ["cnb", host.id, workspaceId, "context"] });
    },
  });
  const text = { color: theme.colors.foreground };
  const linked = item.workspace;
  const own = linked?.id === workspaceId;
  return (
    <View style={{ gap: 10 }}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600", fontSize: 17 }}>{item.title}</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>#{item.number} · {item.state}</Text>
      {item.body ? <Markdown>{item.body}</Markdown> : <Text style={text}>暂无正文</Text>}
      <SettingsAction label="CNB" actionLabel="打开原页" onPress={() => {
        setExternalError("");
        void openExternalUrl(item.url).catch((error: unknown) => setExternalError(
          error instanceof Error ? error.message : String(error),
        ));
      }} />
      {externalError && <Text accessibilityRole="alert" style={text}>{externalError}</Text>}
      {item.related.filter((candidate) => candidate.id !== item.workspace?.id).map((candidate) => (
        <SettingsAction key={candidate.id} label={candidate.title} actionLabel="打开动态关联工作区" disabled={!navigation}
          onPress={() => navigation?.openWorkspace({ workspaceId: candidate.id })} />
      ))}
      {linked && <SettingsAction label={linked.title} actionLabel={navigation ? "打开关联工作区" : "已关联"}
        disabled={!navigation} onPress={() => navigation?.openWorkspace({ workspaceId: linked.id })} />}
      {!linked && !context.issue && <SettingsAction label="Issue 关联" actionLabel="关联到当前工作区"
        disabled={action.isPending} onPress={() => action.mutate("link")} />}
      {own && <SettingsAction label="Issue 关联" actionLabel="解除关联"
        disabled={action.isPending} onPress={() => action.mutate("unlink")} />}
      {(!linked || action.error || (own && context.issue?.branch)) && !preparing && (
        <SettingsAction label="独立工作区" actionLabel="从 Issue 开工"
          disabled={!context.branches.length || action.isPending} onPress={() => setPreparing(true)} />
      )}
      {preparing && <SettingsCard>
        <SettingsSelect label="基准分支" value={base} onValueChange={(next) => {
          setBase(next);
          setRequestId(newRequestId());
        }} disabled={action.isPending}
          options={[{ value: "", label: "选择分支" }, ...context.branches.map((branch) => ({ value: branch, label: branch }))]} />
        <SettingsSelect label="Agent 模型" value={provider} onValueChange={setProvider}
          options={[{ value: "", label: providers.isFetching ? "正在读取模型" : "选择模型" }, ...options]}
          disabled={providers.isFetching || action.isPending} />
        {providers.error && <>
          <Text accessibilityRole="alert" style={text}>{providers.error.message}</Text>
          <SettingsAction label="Agent 模型" actionLabel="重试" onPress={() => { void providers.refetch(); }} />
        </>}
        {providers.isSuccess && options.length === 0 && <Text style={text}>当前 daemon 没有可用的 Agent 模型</Text>}
        <SettingsAction label="启动 Agent" actionLabel={action.isPending ? "正在启动" : action.error ? "重试" : "确认启动"}
          disabled={!base || !provider || action.isPending || Boolean(action.data?.agentId)}
          onPress={() => action.mutate("start")} />
      </SettingsCard>}
      {action.error && <Text accessibilityRole="alert" style={text}>{action.error.message}</Text>}
      {action.data?.agentId && (
        <SettingsAction label="已关联 Agent" actionLabel={navigation ? "打开 Agent" : "已关联"} disabled={!navigation}
          onPress={() => {
            if (action.data?.agentId) navigation?.openAgent({ agentId: action.data.agentId });
          }} />
      )}
    </View>
  );
}
