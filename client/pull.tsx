import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl, useComposers, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, SettingsAction, SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { failed, openPullWorktree, pullChecks, pullDraft, pullFeedback, pullOverview, pullStages, requestNpc } from "../shared/pulls";
import { PullError, PullInput, type Theme } from "./pull-ui";
import { PullReview } from "./pull-review";

type Target = RpcInput<typeof pullOverview>;
type Snapshot = RpcInput<typeof pullChecks>;
type Pull = RpcOutput<typeof pullOverview>;
type Draft = RpcOutput<typeof pullDraft>;
type DraftInput = RpcInput<typeof pullDraft>;
type PageProps = { theme: Theme; snapshot: Snapshot; queryKey: readonly unknown[]; prepare(input: DraftInput): void };
const tabs = [
  { value: "checks", label: "检查" },
  { value: "feedback", label: "反馈" },
  { value: "files", label: "文件与评审" },
  { value: "actions", label: "操作" },
] as const;
const blockers: Record<string, string> = {
  no_merge_base: "找不到共同基准", internal_error: "CNB 检查发生内部错误",
  code_conflict: "存在代码冲突", status_check: "等待通过状态检查", waiting_review: "等待所需的评审",
};

export function PullDetail({ target, host, theme, navigation }: PluginSurfaceProps & { target: Target }) {
  const [tab, setTab] = useState<Tab>("checks");
  const get = useRpc(pullOverview);
  const cache = useQueryClient();
  const key = ["cnb", host.id, target.workspaceId, "pull", target.repository, target.number] as const;
  const query = useQuery({
    queryKey: key, queryFn: () => get(target), retry: false,
    refetchInterval: (query) => query.state.data?.state === "open" ? 30_000 : false,
  });
  const pr = query.data;
  async function refresh() {
    await cache.invalidateQueries({ queryKey: key });
    await cache.invalidateQueries({ queryKey: ["cnb", host.id, target.workspaceId, "current-pull"] });
  }
  return <View style={{ gap: 8 }}>
    <SettingsAction label={`CNB PR #${target.number}`} actionLabel={query.isFetching ? "读取中" : "刷新"}
      disabled={query.isFetching} onPress={() => { void cache.invalidateQueries({ queryKey: key }); }} />
    <PullError theme={theme} error={query.error?.message} />
    {pr && <>
      {query.isSuccess && <PullRevision key={`${pr.head.sha}:${pr.base.sha}`} pr={pr}
        target={target} theme={theme} navigation={navigation} queryKey={key} refresh={refresh} tab={tab} setTab={setTab} />}
      <PullReview key={JSON.stringify(key)} snapshot={{ ...target, head: pr.head.sha, base: pr.base.sha }}
        queryKey={[...key, pr.head.sha, pr.base.sha]} theme={theme} isOpen={pr.state === "open"}
        visible={tab === "files" && query.isSuccess} refresh={refresh} />
    </>}
  </View>;
}

type Tab = (typeof tabs)[number]["value"];
function PullRevision({ pr, target, theme, navigation, queryKey, refresh, tab, setTab }: {
  pr: Pull; target: Target; theme: Theme; navigation: PluginSurfaceProps["navigation"];
  queryKey: readonly unknown[]; refresh(): Promise<void>; tab: Tab; setTab(tab: Tab): void;
}) {
  const [externalError, setExternalError] = useState("");
  const getDraft = useRpc(pullDraft);
  const draft = useMutation({ mutationFn: getDraft });
  const snapshot = { ...target, head: pr.head.sha, base: pr.base.sha };
  const props = { snapshot, theme, queryKey: [...queryKey, pr.head.sha, pr.base.sha], prepare: draft.mutate };
  const foreground = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const blocked = pr.blockedOn && (blockers[pr.blockedOn] ?? pr.blockedOn);
  return <View style={{ gap: 8 }}>
    <Text accessibilityRole="header" style={{ ...foreground, fontWeight: "600", fontSize: 16 }}>{pr.title}</Text>
    <Text style={muted}>{pr.head.path === pr.base.path ? pr.head.branch : `${pr.head.path}:${pr.head.branch}`} → {pr.base.branch}</Text>
    <Text selectable style={muted}>{pr.state}{pr.draft ? " · 草稿" : ""} · {pr.head.sha.slice(0, 12)}</Text>
    {pr.body && <Text selectable style={foreground}>{pr.body}</Text>}
    {pr.state === "open" && blocked && <Text style={foreground}>合并受阻 · {blocked}</Text>}
    {pr.state === "open" && !blocked && pr.mergeableState && <Text style={muted}>合并状态 · {pr.mergeableState}</Text>}
    <SettingsAction label={pr.base.path} actionLabel="在 CNB 打开" onPress={() => {
      setExternalError("");
      void openExternalUrl(pr.url).catch((error: unknown) => setExternalError(String(error)));
    }} />
    <PullError theme={theme} error={externalError} />
    {pr.workspaces.filter((workspace) => workspace.id !== target.workspaceId).map(({ id, title }) => (
      <SettingsAction key={id} label={title} actionLabel="打开关联工作区" disabled={!navigation}
        onPress={() => navigation?.openWorkspace({ workspaceId: id })} />
    ))}
    <SettingsSelect label="PR 内容" value={tab} options={tabs} onValueChange={(tab) => { setTab(tab); draft.reset(); }} />
    {tab === "checks" && <Checks {...props} />}
    {tab === "feedback" && <Feedback {...props} />}
    {tab === "actions" && <PullActions snapshot={snapshot} pr={pr} theme={theme} navigation={navigation} refresh={refresh}
      showFeedback={() => setTab("feedback")} />}
    {draft.isPending && <Text accessibilityLiveRegion="polite" style={muted}>正在准备 Agent 草稿</Text>}
    <PullError theme={theme} error={draft.error?.message} />
    {draft.data && <DraftPreview key={draft.submittedAt} theme={theme} draft={draft.data} onDone={draft.reset} />}
  </View>;
}

function Checks({ theme, snapshot, queryKey, prepare }: PageProps) {
  const read = useRpc(pullChecks);
  const getStages = useRpc(pullStages);
  const [build, setBuild] = useState("");
  const query = useQuery({
    queryKey: [...queryKey, "checks"], queryFn: () => read(snapshot), retry: false, refetchInterval: 35_000,
  });
  const stages = useQuery({
    queryKey: [...queryKey, "stages", build], queryFn: () => getStages({ ...snapshot, build }), enabled: Boolean(build), retry: false,
  });
  const muted = { color: theme.colors.foregroundMuted };
  const foreground = { color: theme.colors.foreground };
  return <View style={{ gap: 8 }}>
    {query.isFetching && !query.data && <Text style={muted}>正在读取提交检查</Text>}
    <PullError theme={theme} error={query.error?.message} retry={() => { void query.refetch(); }} />
    {query.isSuccess && <>
      <Text style={foreground}>检查状态 · {query.data.state}</Text>
      {!query.data.checks.length && <Text style={muted}>CNB 尚未上报检查。</Text>}
      {query.data.checks.length > 0 && <SettingsCard>
        {query.data.checks.map((check, index) => failed(check.state)
          ? <SettingsAction key={index} label={`${check.name} · ${check.state}`} hint={check.description}
            actionLabel="准备修复草稿" onPress={() => prepare({ ...snapshot, kind: "check", index, name: check.name })} />
          : <View key={index} style={{ padding: 8, gap: 2 }}>
            <Text style={foreground}>{check.name} · {check.state}</Text>
            {check.description && <Text style={muted}>{check.description}</Text>}
          </View>)}
      </SettingsCard>}
      <PullError theme={theme} error={query.data.buildError} retry={() => { void query.refetch(); }} />
      {query.data.builds.length > 0 && <SettingsSelect label="当前提交的失败构建" value={build} onValueChange={setBuild}
        options={[{ label: "选择构建", value: "" }, ...query.data.builds.map((item) => ({
          value: item.id, label: `${item.title} · ${item.event} · ${item.id}`,
        }))]} />}
      {query.data.moreBuilds && <Text style={muted}>此处显示最近 20 个失败构建，完整历史可在 CNB 查看。</Text>}
    </>}
    {build && stages.isFetching && <Text style={muted}>正在读取失败阶段</Text>}
    <PullError theme={theme} error={stages.error?.message} retry={() => { void stages.refetch(); }} />
    {stages.isSuccess && stages.data.length === 0 && <Text style={muted}>CNB 未返回可查看的失败阶段。</Text>}
    {stages.isSuccess && stages.data.map((stage) => <SettingsAction key={`${stage.pipeline}:${stage.id}`} label={stage.name}
      hint={stage.state} actionLabel="带上日志准备草稿"
      onPress={() => prepare({ ...snapshot, kind: "stage", build, pipeline: stage.pipeline, stage: stage.id })} />)}
  </View>;
}

function Feedback({ theme, snapshot, queryKey, prepare }: PageProps) {
  const read = useRpc(pullFeedback);
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [...queryKey, "feedback", page],
    queryFn: () => read({ ...snapshot, page }), retry: false,
  });
  const muted = { color: theme.colors.foregroundMuted };
  const foreground = { color: theme.colors.foreground };
  return <View style={{ gap: 8 }}>
    <SettingsAction label={`反馈第 ${page} 页`} actionLabel="刷新" disabled={query.isFetching}
      onPress={() => { void query.refetch(); }} />
    <PullError theme={theme} error={query.error?.message} />
    {query.isFetching && !query.data && <Text style={muted}>正在读取评审和评论</Text>}
    {query.isSuccess && query.data.items.length === 0 && <Text style={muted}>此页暂无评审或评论。</Text>}
    {query.isSuccess && query.data.items.map((item) => <View key={item.id} style={{ padding: 8, gap: 6, borderRadius: 6, backgroundColor: theme.colors.surface1 }}>
      <Text style={foreground}>{item.author}{item.state ? ` · ${item.state}` : ""}</Text>
      {item.path && <Text selectable style={muted}>{item.path}{item.line ? `:${item.line}` : ""}{item.commit ? ` · ${item.commit.slice(0, 12)}` : ""}</Text>}
      {item.body && <Text selectable style={foreground}>{item.body}</Text>}
      {item.npc.map(({ name, state }, index) => <Text key={index} style={muted}>{name} · {state}</Text>)}
      {item.body.trim() && <SettingsAction label="评审上下文" actionLabel="准备 Agent 草稿"
        onPress={() => prepare({ ...snapshot, kind: "feedback", page, id: item.id })} />}
    </View>)}
    {page > 1 && <SettingsAction label="反馈分页" actionLabel="上一页" onPress={() => setPage(page - 1)} />}
    {query.data?.more && <SettingsAction label="反馈分页" actionLabel="下一页" onPress={() => setPage(page + 1)} />}
  </View>;
}

function DraftPreview({ draft, theme, onDone }: { draft: Draft; theme: Theme; onDone(): void }) {
  const [text, setText] = useState(draft.text);
  const [agentId, setAgentId] = useState(draft.agents.find((agent) => agent.preferred)?.id ??
    (draft.agents.length === 1 ? draft.agents[0].id : ""));
  const [composer] = useComposers({ agentId });
  const insert = useMutation({
    async mutationFn() {
      if (!composer) throw new Error("所选 Agent 输入框不可用，请打开 Agent 后重试");
      await composer.focus();
      composer.setPrompt(composer.prompt ? `${composer.prompt}\n\n${text}` : text);
    },
    onSuccess: onDone,
  });
  const copy = useMutation({ mutationFn: () => copyText(text) });
  const muted = { color: theme.colors.foregroundMuted };
  return <View style={{ gap: 8 }}>
    <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>Agent 草稿</Text>
    <Text style={muted}>检查日志和外部文字后，可把草稿加入 Agent 的输入框。</Text>
    <PullInput theme={theme} accessibilityLabel="Agent 草稿" multiline value={text} onChangeText={setText}
      style={{ minHeight: 140, maxHeight: 280 }} />
    {draft.agents.length > 0 ? <>
      <SettingsSelect label="Agent" value={agentId} onValueChange={setAgentId} options={[
        { label: "选择 Agent", value: "" },
        ...draft.agents.map((agent) => ({ value: agent.id, label: agent.preferred ? `${agent.title} · 原 Issue Agent` : agent.title })),
      ]} />
      <SettingsAction label="追加到 Agent 的输入框" actionLabel="打开 Agent"
        disabled={!agentId || !text.trim() || insert.isPending} onPress={() => insert.mutate()} />
    </> : <Text style={muted}>此 PR 暂无可用的关联 Agent，可以复制草稿。</Text>}
    <SettingsAction label={copy.isSuccess ? "草稿已复制" : "Agent 草稿"} actionLabel="复制"
      disabled={!text.trim() || copy.isPending} onPress={() => copy.mutate()} />
    <SettingsAction label="Agent 草稿" actionLabel="关闭" onPress={onDone} />
    <PullError theme={theme} error={insert.error?.message ?? copy.error?.message} />
  </View>;
}

function PullActions({ snapshot, pr, theme, navigation, refresh, showFeedback }: {
  snapshot: Snapshot; pr: Pull; theme: Theme; navigation: PluginSurfaceProps["navigation"];
  refresh(): Promise<void>; showFeedback(): void;
}) {
  const createWorktree = useRpc(openPullWorktree);
  const askNpc = useRpc(requestNpc);
  const [confirmNpc, setConfirmNpc] = useState(false);
  const worktree = useMutation({ mutationFn: () => createWorktree(snapshot) });
  const npc = useMutation({ mutationFn: () => askNpc(snapshot), onSuccess: () => { setConfirmNpc(false); return refresh(); } });
  const sameRepo = pr.head.path === pr.base.path;
  const open = pr.state === "open";
  const foreground = { color: theme.colors.foreground };
  const busy = worktree.isPending || npc.isPending;
  return <View style={{ gap: 8 }}>
    {sameRepo && <SettingsAction label="独立评审工作区" hint={`检出 ${pr.head.sha.slice(0, 12)}`}
      actionLabel={worktree.isPending ? "创建中" : "创建或复用"} disabled={busy} onPress={() => worktree.mutate()} />}
    {!sameRepo && <Text style={foreground}>Fork PR 可在文件与评审页评审。独立 worktree 当前支持同仓库 PR。</Text>}
    {worktree.data && <SettingsAction label={worktree.data.title} actionLabel="打开评审工作区" disabled={!navigation}
      onPress={() => { if (worktree.data) navigation?.openWorkspace({ workspaceId: worktree.data.id }); }} />}
    <PullError theme={theme} error={worktree.error?.message} />
    {open && <SettingsCard>
      <SettingsAction label="CodeBuddy 评审" actionLabel={confirmNpc ? "取消" : "请求 NPC 评审"} disabled={busy}
        onPress={() => setConfirmNpc(!confirmNpc)} />
      {confirmNpc && <SettingsAction label="在此 PR 发布 @CodeBuddy 评论" actionLabel="确认请求"
        disabled={busy} onPress={() => npc.mutate()} />}
      {npc.data && <SettingsAction label="已提交 NPC 评审请求" actionLabel="查看反馈" onPress={showFeedback} />}
    </SettingsCard>}
    <PullError theme={theme} error={npc.error?.message} />
  </View>;
}
