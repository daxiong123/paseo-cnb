import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  activity, autoSync, changeShareUrl, connection, createIssueWorkspace, getItem, inboxIssue, inspectRepository, issueAction, issueKey,
  listItems, preferences, searchIssues, shareKey, workspaceContext,
} from "./shared/cnb";
import { cnb, issueText, parseIssueUrl, repoPath, resolveManualRepository, type Repository } from "./server/cnb";
import { cliAuth } from "./server/cli-auth";
import { registerPulls } from "./server/pulls";
import { activityPath, activityStatus, readActivityState, relatedWorkspaces, synchronizeActivity, workspaceShareUrl } from "./server/activity";
import {
  cnbRemotes, describe, findIssue, getWorkspace, issueMetadata, linkedWorkspace, matchesGitRepository,
  selectGitRepository, startIssue, workspacePages,
  type Workspace,
} from "./server/workspaces";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const authenticate = cliAuth();
  const pending = new Map<string, Promise<void>>();
  let lastPoll = 0;

  async function serial<T>(key: string, run: () => Promise<T>) {
    const previous = pending.get(key);
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    pending.set(key, lock);
    try {
      await previous;
      return await run();
    } finally {
      release();
      if (pending.get(key) === lock) pending.delete(key);
    }
  }

  async function daemonId({ paseo }: PluginHandlerContext) {
    const { self } = await paseo.hosts.list();
    return self.serverId;
  }

  async function api() {
    return cnb((await authenticate()).token);
  }

  async function readPreferences() {
    const state = await settings.read();
    if (state.status === "invalid") throw new Error(`CNB 仓库配对配置无效：${state.error}`);
    return state.values;
  }

  async function selectedRepository(
    project: Pick<Workspace, "projectKind" | "projectRootPath"> | undefined,
    manual: Repository | undefined,
    getClient = api,
    knownRemotes?: string[],
  ) {
    if (manual) return resolveManualRepository(manual, (await getClient()).repo);
    if (!project) return null;
    const remotes = knownRemotes ?? await cnbRemotes(project);
    if (!remotes.length) return null;
    return selectGitRepository(remotes, (await getClient()).repo);
  }

  async function target(workspaceId: string, { paseo }: PluginHandlerContext) {
    const workspace = await getWorkspace(paseo, workspaceId);
    const values = await readPreferences();
    let client: ReturnType<typeof api> | undefined;
    const getClient = () => client ??= api();
    const repo = await selectedRepository(workspace, values.projects[workspace.projectId], getClient);
    if (!repo) throw new Error("项目未发现 CNB 远端，请在 CNB 面板填写仓库地址");
    return { workspace, repo, getClient };
  }

  function requireRepository(current: string, expected: string) {
    if (current !== expected) throw new Error("项目的 CNB 仓库已变化，请在 CNB 面板重新读取仓库");
  }

  async function inboxTarget(projectId: string, repository: string, { paseo }: PluginHandlerContext) {
    const [{ projects }, catalog, client] = await Promise.all([readPreferences(), paseo.projects.list(), api()]);
    const project = catalog.projects.find((entry) => entry.projectId === projectId);
    const repo = await selectedRepository(project, projects[projectId], async () => client);
    if (!repo) throw new Error("项目的 CNB 仓库已变化，请刷新待办");
    requireRepository(repo.path, repository);
    return { project, repo, client };
  }

  async function related(context: PluginHandlerContext, workspace: Workspace, repo: Repository, resource: "issues" | "pulls", number: string) {
    const state = await readActivityState(activityPath(await daemonId(context), workspace.projectId, repo.id));
    return relatedWorkspaces(state, { resource, number }, (id) => context.paseo.workspaces.ref(id).refresh());
  }

  registerPulls(server, { api, target, readPreferences, serial, related });

  async function syncProject(projectId: string, repositoryId: string, context: PluginHandlerContext, retry: boolean) {
    return serial(`activity:${repositoryId}`, async () => {
      const preferences = await readPreferences();
      const config = preferences.automation[projectId];
      if (config?.repositoryId !== repositoryId) {
        throw new Error("仓库配对或同步设置已变化，请刷新后重试");
      }
      const workspaces: Workspace[] = [];
      for await (const entries of workspacePages(context.paseo)) workspaces.push(...entries);
      let source: Parameters<typeof selectedRepository>[0] | undefined =
        workspaces.find((workspace) => workspace.projectId === projectId && !workspace.archivingAt);
      if (!source && !preferences.projects[projectId]) {
        const { projects } = await context.paseo.projects.list();
        source = projects.find((project) => project.projectId === projectId);
      }
      let client: ReturnType<typeof api> | undefined;
      const getClient = () => client ??= api();
      const repo = await selectedRepository(source, preferences.projects[projectId], getClient);
      if (repo?.id !== repositoryId) throw new Error("自动同步的 CNB 仓库已变化，请在 CNB 面板确认仓库");
      const file = activityPath(await daemonId(context), projectId, repo.id);
      return synchronizeActivity({
        file, repo, config, workspaces,
        async projects() {
          const projects: Record<string, Repository> = { [projectId]: repo };
          const peers = new Map(workspaces.filter((workspace) =>
            !workspace.archivingAt && workspace.projectId !== projectId && issueMetadata(workspace))
            .map((workspace) => [workspace.projectId, workspace]));
          await Promise.all([...peers].map(async ([id, workspace]) => {
            const repository = await selectedRepository(workspace, preferences.projects[id], getClient);
            if (repository) projects[id] = repository;
          }));
          return projects;
        },
        client: getClient,
        retry,
        async canPublish(linkedWorkspaceId, url, issue) {
          const latest = await readPreferences();
          const latestConfig = latest.automation[projectId];
          if (latestConfig?.repositoryId !== repo.id || latestConfig.commentsSince !== config.commentsSince
            || latestConfig?.commentsUsername !== config.commentsUsername) return false;
          const linked = await context.paseo.workspaces.ref(linkedWorkspaceId).refresh();
          const reference = linked && issueMetadata(linked);
          if (!linked || linked.archivingAt || reference?.repositoryId !== issue.repositoryId
            || reference.number !== issue.number || workspaceShareUrl(linked) !== url) return false;
          const linkedRepo = await selectedRepository(linked, latest.projects[linked.projectId], getClient);
          const ownerRepo = linked.projectId === projectId ? linkedRepo : await selectedRepository(source, latest.projects[projectId], getClient);
          return ownerRepo?.id === repo.id && linkedRepo?.id === issue.repositoryId;
        },
      });
    });
  }

  server.handle(connection, async () => {
    const { token, cliVersion } = await authenticate();
    const user = await cnb(token).account();
    return { username: user.username, cliVersion };
  });

  server.handle(workspaceContext, async ({ workspaceId }, { paseo }) => {
    const workspace = await getWorkspace(paseo, workspaceId);
    const [git, { projects }] = await Promise.all([describe(workspace), readPreferences()]);
    const result = { projectId: workspace.projectId, issue: issueMetadata(workspace), shareUrl: workspaceShareUrl(workspace), ...git };
    try {
      const repository = await selectedRepository(workspace, projects[workspace.projectId], api, git.remotes);
      return { ...result, repository, repositoryError: null };
    } catch (error) {
      console.warn("cnb.workspace.discovery.failed", { workspaceId, projectId: workspace.projectId, path: git.remotes[0] });
      return { ...result, repository: null, repositoryError: error instanceof Error ? error.message : String(error) };
    }
  });

  server.handle(changeShareUrl, async ({ workspaceId, url, repositoryId }, context) => {
    const { workspace, repo } = await target(workspaceId, context);
    requireRepository(repo.id, repositoryId);
    if (url && issueMetadata(workspace)?.repositoryId !== repo.id) throw new Error("为当前仓库关联一个 Issue 后才能保存回链地址");
    await context.paseo.workspaces.ref(workspaceId).setMetadata({ [shareKey]: url });
    console.info("cnb.workspace.share-url", { workspaceId, action: url ? "saved" : "deleted" });
    return { url };
  });

  server.handle(activity, async ({ workspaceId, action, repositoryId }, context) => {
    const { workspace, repo } = await target(workspaceId, context);
    requireRepository(repo.id, repositoryId);
    if (action === "status") {
      const file = activityPath(await daemonId(context), workspace.projectId, repo.id);
      return activityStatus(await readActivityState(file));
    }
    return syncProject(workspace.projectId, repo.id, context, action === "retry");
  });

  server.handle(autoSync, async (_input, context) => {
    if (Date.now() - lastPoll < 55_000) return {};
    lastPoll = Date.now();
    const values = await readPreferences();
    const enabled = Object.entries(values.automation).filter(([project, config]) =>
      !values.projects[project] || values.projects[project].id === config.repositoryId);
    const results = await Promise.allSettled(enabled.map(([id, config]) => syncProject(id, config.repositoryId, context, false)));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") console.error("cnb.activity.auto-sync.failed", { projectId: enabled[index][0], error: String(result.reason) });
    }
    return {};
  });

  server.handle(inspectRepository, async ({ url, workspaceId }, context) => {
    await getWorkspace(context.paseo, workspaceId);
    const path = repoPath(url);
    const client = await api();
    const repo = await client.repo(path);
    await Promise.all([client.list(repo, "issues", 1, ""), client.list(repo, "pulls", 1, "")]);
    console.info("cnb.repository.verified", { workspaceId, path: repo.path });
    return repo;
  });

  server.handle(listItems, async ({ workspaceId, resource, page, keyword, repository }, context) => {
    const { repo, getClient } = await target(workspaceId, context);
    requireRepository(repo.path, repository);
    return (await getClient()).list(repo, resource, page, keyword);
  });

  server.handle(getItem, async ({ workspaceId, resource, number, repository }, context) => {
    const { workspace, repo, getClient } = await target(workspaceId, context);
    requireRepository(repo.path, repository);
    const client = await getClient();
    const [item, linked, workspaces] = await Promise.all([
      client.item(repo, resource, number),
      findIssue(context.paseo, workspace.projectId, repo.id, number),
      related(context, workspace, repo, resource, number),
    ]);
    return { ...item, workspace: linked ? linkedWorkspace(linked) : null, related: workspaces };
  });

  server.handle(inboxIssue, async ({ projectId, repository, number }, context) => {
    const { project, repo, client } = await inboxTarget(projectId, repository, context);
    const [issue, existing] = await Promise.all([
      client.item(repo, "issues", number), findIssue(context.paseo, projectId, repo.id, number),
    ]);
    const result = {
      ...issue, repositoryId: repo.id, workspace: existing ? linkedWorkspace(existing) : null,
      branches: [], base: null, workspaceError: null,
    };
    if (existing || issue.state !== "open") return result;
    if (project?.projectKind !== "git") return { ...result, workspaceError: "创建工作区需要此项目的本地 Git 检出" };
    try {
      const { remotes, branch, branches } = await describe(project);
      if (!await matchesGitRepository(remotes, repo.path, client.repo)) throw new Error("项目的 Git remote 与当前 CNB 仓库不一致");
      if (!branches.length) throw new Error("项目没有可用的本地基准分支");
      return { ...result, branches, base: branch && branches.includes(branch) ? branch : null };
    } catch (error) {
      console.warn("cnb.inbox.issue.git-unavailable", { projectId, repo: repo.path, number });
      return { ...result, workspaceError: error instanceof Error ? error.message : String(error) };
    }
  });

  server.handle(createIssueWorkspace, (input, context) => serial(`project:${input.projectId}`, async () => {
    const { project, repo, client } = await inboxTarget(input.projectId, input.repository, context);
    requireRepository(repo.id, input.repositoryId);
    const existing = await findIssue(context.paseo, input.projectId, repo.id, input.number);
    if (existing) return { workspace: linkedWorkspace(existing) };
    if (project?.projectKind !== "git") throw new Error("创建工作区需要此项目的本地 Git 检出");
    const issue = await client.item(repo, "issues", input.number);
    if (issue.state !== "open") throw new Error("Issue 已关闭，请刷新待办");
    return startIssue(context.paseo, project, null, repo, issue, input.base, null, client.repo, input.requestId);
  }));

  server.handle(issueAction, async (input, context) => {
    const { paseo } = context;
    const workspace = await getWorkspace(paseo, input.workspaceId);
    return serial(`project:${workspace.projectId}`, async () => {
      if (input.action === "unlink") {
        const workspace = await getWorkspace(paseo, input.workspaceId);
        const current = issueMetadata(workspace);
        if (current?.repositoryId !== input.repositoryId || current.number !== input.number) {
          throw new Error("当前工作区与该 Issue 的关联已变化，请刷新后重试");
        }
        await paseo.workspaces.ref(workspace.id).setMetadata({ [issueKey]: null, [shareKey]: null });
        console.info("cnb.issue.unlinked", { workspaceId: workspace.id, repo: current.path, number: input.number });
        return { workspace: linkedWorkspace(workspace) };
      }

      const { workspace, repo, getClient } = await target(input.workspaceId, context);
      requireRepository(repo.id, input.repositoryId);
      const current = issueMetadata(workspace);
      const client = await getClient();
      const issue = await client.item(repo, "issues", input.number);
      const existing = await findIssue(paseo, workspace.projectId, repo.id, issue.number);
      if (input.action === "start") {
        return startIssue(paseo, workspace, existing, repo, issue, input.base, input.provider, client.repo, input.requestId);
      }
      if (existing && existing.id !== workspace.id) throw new Error("此 Issue 已关联另一个工作区");
      if (current && !existing) throw new Error("当前工作区已关联其他 Issue，请先解除关联");
      if (!current) {
        await paseo.workspaces.ref(workspace.id).setMetadata({
          [issueKey]: { repositoryId: repo.id, path: repo.path, number: issue.number },
        });
        console.info("cnb.issue.linked", { workspaceId: workspace.id, repo: repo.path, number: issue.number });
      }
      return { workspace: linkedWorkspace(workspace) };
    });
  });

  server.handle(searchIssues, async ({ query }) => {
    const reference = parseIssueUrl(query);
    if (!reference) return { items: [] };
    const client = await api();
    const repo = await client.repo(reference.path);
    const issue = await client.item(repo, "issues", reference.number);
    return { items: [{
      id: `${repo.id}:${issue.number}`,
      identifier: `${repo.path}#${issue.number}`,
      title: issue.title,
      url: issue.url,
      resourceType: "issue" as const,
      text: issueText(issue),
    }] };
  });

  return () => {};
}
