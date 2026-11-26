import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcOutput } from "@getpaseo/plugin";
import { issueKey } from "../shared/cnb.ts";
import {
  createPull, currentPull, diffLines, openPullWorktree, pullChecks, pullDraft, pullFeedback,
  pullFile, pullInbox, pullKey, pullOverview, pullReview, requestNpc,
} from "../shared/pulls.ts";
import { cnb } from "../server/cnb.ts";
import { registerPulls } from "../server/pulls.ts";
import { issueOperation, type Workspace } from "../server/workspaces.ts";

const repo = { id: "99", path: "team/sub/repo", webUrl: "https://cnb.cool/team/sub/repo" };
const second = { id: "100", path: "team/other", webUrl: "https://cnb.cool/team/other" };
const branch = "cnb/issue-42";
const patch = "@@ -5,2 +5,3 @@\n same\n-old\n+new\n+next\n";

test("unified diff keeps sides, zero-width hunks and file header lines separate", () => {
  const rows = diffLines(`+++ b/file\n${patch}@@ -0,0 +20,1 @@\n+++src\n\\ No newline at end of file\n`);
  assert.deepEqual(rows.slice(0, 6).map(({ left, right }) => [left, right]), [
    [null, null], [null, null], [5, 5], [6, null], [null, 6], [null, 7],
  ]);
  assert.equal(rows.find(({ text }) => text === "+++src")?.right, 20);
  assert.equal(rows.at(-2)?.right, null);
});

test("repeating an approval is a new review, retrying its request is not", async () => {
  const posted: { id: string; body: string; state: string; author: { username: string } }[] = [];
  const client = cnb("fixture", async (_url, options) => {
    if (options?.method !== "POST") return Response.json(posted);
    const { body, event } = JSON.parse(String(options.body));
    posted.push({ id: String(posted.length + 1), body, state: event, author: { username: "mel" } });
    return Response.json({});
  });
  const submit = (requestId: string, event: "approve" | "request_changes") =>
    client.submitReview(repo, "71", { requestId, event, body: event === "approve" ? "" : "请修改", comments: [] }, "mel", async () => {});
  await submit("submit-first-approval", "approve");
  await submit("request-changes-again", "request_changes");
  await submit("submit-next-approval", "approve");
  await submit("submit-next-approval", "approve");
  assert.deepEqual(posted.map(({ state }) => state), ["approve", "request_changes", "approve"]);
});

test("Issue worktree to PR, failure and feedback drafts, review, NPC, and inbox", async () => {
  const directory = mkdtempSync(join(tmpdir(), "better-paseo-cnb-pull-"));
  try {
    const root = join(directory, "repo");
    const source = join(directory, "source");
    const bare = join(directory, "remote.git");
    const reviewPath = join(directory, "review");
    const autoRoot = join(directory, "auto");
    const ambiguousRoot = join(directory, "ambiguous");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = (cwd: string, title: string) =>
      git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
        "commit", "--allow-empty", "-m", title);
    git(directory, "init", "-b", "main", root);
    commit(root, "base");
    const base = git(root, "rev-parse", "HEAD");
    git(directory, "clone", "--bare", root, bare);
    const originAlias = "sub/repo";
    const secondAlias = "previous/other";
    const origin = `https://cnb.cool/${originAlias}.git`;
    git(root, "remote", "add", "origin", origin);
    git(root, "config", "--add", `url.${bare}.insteadOf`, `${repo.webUrl}.git`);
    git(root, "remote", "set-url", "--push", "origin", bare);
    git(root, "worktree", "add", "-b", branch, source);
    git(directory, "init", autoRoot);
    git(autoRoot, "remote", "add", "upstream", second.webUrl);
    git(autoRoot, "remote", "add", "mirror", `https://cnb.cool/${secondAlias}.git`);
    git(autoRoot, "remote", "add", "other-host", "https://cnb.cool.example/team/elsewhere");
    git(directory, "init", ambiguousRoot);
    git(ambiguousRoot, "remote", "add", "upstream", second.webUrl);
    git(ambiguousRoot, "remote", "add", "origin", "https://cnb.cool/team/fork");
    commit(source, "head");
    const head = git(source, "rev-parse", "HEAD");
    const workspace = {
      id: "source", projectId: "project", projectKind: "git", workspaceDirectory: source, projectRootPath: root,
      title: "Issue worktree",
      metadata: { [issueKey]: { repositoryId: repo.id, path: repo.path, number: "42", branch } },
    } as unknown as Workspace;
    const main = { ...workspace, id: "main", workspaceDirectory: root, metadata: {} };
    let agentOperation = issueOperation(workspace.projectId, repo.id, "42");
    const auto = { ...main, id: "auto", projectId: "auto-project", projectRootPath: autoRoot };
    const ambiguous = { projectId: "ambiguous", projectDisplayName: "Fork project", projectKind: "git", projectRootPath: ambiguousRoot };
    const writes = { pr: 0, review: 0, npc: 0 };
    let detailReads = 0;
    let pr: ReturnType<typeof revision> | null = null;
    let npcComment: { id: string; body: string; author: { username: string } } | null = null;
    let reviewBody: string | null = null;
    let stagesAvailable = true;
    let reviewKey = "";
    let reviewWorkspace: Workspace | null = null;
    const token = "fake-cnb-token";
    const author = { username: "mel" };
    const issue = { number: "42", title: "修复登录", state: "open", body: "" };

    function revision() {
      return {
        number: "71", title: "修复登录", body: "See issue #42", state: "open", blocked_on: "", is_wip: false, mergeable_state: "mergeable",
        head: { repo: { path: repo.path }, ref: `refs/heads/${branch}`, sha: head },
        base: { repo: { path: repo.path }, ref: "refs/heads/main", sha: base },
        reviewers: [{ user: author, review_state: "pending" }],
      };
    }
    const snapshot = { workspaceId: workspace.id, repository: repo.path, number: "71", head, base };

    const unexpected: string[] = [];
    const api = cnb(token, async (value, init) => {
      const url = new URL(String(value));
      const method = init?.method;
      assert.equal(url.origin, "https://api.cnb.cool");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
      if (url.pathname === "/user") return Response.json(author);
      if ([`/${repo.path}`, `/${originAlias}`].includes(url.pathname)) {
        return Response.json({ id: repo.id, path: repo.path, web_url: repo.webUrl });
      }
      if ([`/${second.path}`, `/${secondAlias}`].includes(url.pathname)) {
        return Response.json({ id: second.id, path: second.path, web_url: second.webUrl });
      }
      if (url.pathname === "/team/fork") {
        return Response.json({ id: "101", path: "team/fork", web_url: "https://cnb.cool/team/fork" });
      }
      if (url.pathname.startsWith(`/${second.path}/-/`)) {
        return Response.json({ message: "no access" }, { status: 403 });
      }
      const path = url.pathname.replace(`/${repo.path}/-/`, "");
      if (path === "issues/42") return Response.json(issue);
      if (path === "issues") {
        assert.equal(url.searchParams.get("state"), "open");
        if (url.searchParams.get("assignees") === author.username) return Response.json([issue]);
        assert.equal(url.searchParams.has("assignees"), false);
        return Response.json([issue, { ...issue, number: "43", title: "未分配的 Issue" }]);
      }
      if (path === "pulls" && method === "GET") {
        const filter = url.searchParams.get("reviewers") ?? url.searchParams.get("authors");
        if (filter) assert.equal(filter, author.username);
        return Response.json(pr?.state === "open" ? [pr] : []);
      }
      if (path === "pulls" && method === "POST") {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          head: branch, head_repo: repo.path, base: "main", title: issue.title, body: "See issue #42",
        });
        writes.pr++;
        pr = revision();
        // Simulate CNB creating the PR before the client sees a timeout.
        throw new Error("simulated lost response");
      }
      if (path === "pulls/71") {
        detailReads++;
        return Response.json(pr);
      }
      if (path === "pulls/71/commit-statuses") return Response.json({
        sha: head, state: "failure", statuses: [{ context: "Unit tests", state: "failure", description: "one test failed" }],
      });
      if (path === "build/logs") {
        assert.equal(url.searchParams.get("sha"), head);
        return stagesAvailable ? Response.json({
          total: 1, data: [{ sn: "cnb-123", sha: head, slug: repo.path, status: "error", event: "pull_request" }],
        }) : Response.json({}, { status: 403 });
      }
      if (path === "build/status/cnb-123") return Response.json({
        pipelinesStatus: { test: { id: "pipe-01", stages: [{ id: "step-01", name: "Test", status: "error" }] } },
      });
      if (path === "build/logs/stage/cnb-123/pipe-01/step-01") return Response.json({
        id: "step-01", name: "Test", status: "error", content: [`\u001b[32mAssertionError: ${token}\u001b[0m`],
      });
      if (path === "pulls/71/files") return Response.json([{ filename: "src/login.ts", status: "modify", patch }]);
      if (path === "pulls/71/reviews" && method === "POST") {
        const { body, ...input } = JSON.parse(String(init?.body));
        assert.match(body, /^请处理空值\n\n<!-- better-paseo-cnb:review:submit-review-attempt-1 -->$/);
        assert.deepEqual(input, {
          event: "request_changes", comments: [{
            path: "src/login.ts", body: "这里会抛异常", subject_type: "line",
            start_side: "right", end_side: "right", start_line: 7, end_line: 7,
          }],
        });
        writes.review++;
        reviewBody = body;
        throw new Error("simulated lost response");
      }
      if (path === "pulls/71/reviews") return Response.json(reviewBody ? [{ id: "7", author, body: reviewBody, state: "changes_requested" }] : []);
      if (path === "pulls/71/reviews/7/comments") return Response.json([{
        id: "12", author, body: "这里会抛异常", path: "src/login.ts", end_line: 7, end_side: "right", commit_hash: head,
      }]);
      if (path === "pulls/71/comments" && method === "POST") {
        const input = JSON.parse(String(init?.body));
        assert.equal(input.work_mode, false);
        assert.match(input.body, /^@CodeBuddy/);
        writes.npc++;
        npcComment = { id: "13", body: input.body, author };
        return Response.json(npcComment, { status: 201 });
      }
      if (path === "pulls/71/comments") return Response.json(npcComment ? [{
        ...npcComment, statuses: { npc: [{ key: { name: "CodeBuddy" }, statuses: [{ state: "success" }] }] },
      }] : []);
      unexpected.push(`${method} ${url.pathname}`);
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });

    const context = { paseo: {
      projects: {
        async list() {
          return { projects: [
            { ...main, projectDisplayName: "Manually selected" },
            { ...main, projectId: "legacy-clone", projectDisplayName: "Alias clone" },
            { ...auto, projectDisplayName: "Automatically detected" },
            ambiguous,
          ] };
        },
      },
      workspaces: {
        async list() { return { entries: [main, workspace, auto, ...(reviewWorkspace ? [reviewWorkspace] : [])], pageInfo: {} }; },
        ref(id: string) {
          assert.equal(id, workspace.id);
          return {
            async refresh() { return workspace; },
            async setMetadata(values: NonNullable<Workspace["metadata"]>) { Object.assign(workspace.metadata!, values); },
          };
        },
        async create(input: {
          idempotencyKey: string; metadata: Workspace["metadata"]; source: { branchName: string; refName: string };
        }) {
          assert.equal(git(root, "rev-parse", input.source.refName), head);
          if (reviewKey) assert.equal(reviewKey, input.idempotencyKey);
          else {
            git(root, "worktree", "add", "-b", input.source.branchName, reviewPath, input.source.refName);
            assert.equal(git(reviewPath, "rev-parse", "HEAD"), head);
            reviewKey = input.idempotencyKey;
            reviewWorkspace = { ...main, id: "review", workspaceDirectory: reviewPath, metadata: input.metadata };
          }
          return {
            id: "review",
            async setBaseBranch({ baseRef }: { baseRef: string }) { assert.equal(git(reviewPath, "rev-parse", baseRef), base); },
          };
        },
      },
      agents: {
        async list() { return { entries: [
          { agent: { id: "other", workspaceId: main.id, title: "Different workspace" } },
          { agent: { id: "original", workspaceId: workspace.id, title: "Original", status: "idle",
            labels: { "better-paseo-cnb.operation": agentOperation } } },
        ], pageInfo: {} }; },
      },
    } } as unknown as PluginHandlerContext;
    const handlers = new Map<string, (input: unknown, context: PluginHandlerContext) => Promise<unknown>>();
    registerPulls({ handle(rpc: { name: string }, handler: (input: unknown, context: PluginHandlerContext) => Promise<unknown>) {
      handlers.set(rpc.name, handler);
    } } as unknown as PluginServerContext, {
      api: async () => api, target: async (id) => ({ workspace: id === main.id ? main : workspace, repo, getClient: async () => api }),
      readPreferences: async () => ({ projects: { project: repo, duplicate: repo, "stale-project": { ...repo, id: "previous-owner" } } }),
      async related(_context, workspace, repository, resource, number) {
        assert.equal(workspace.id, main.id);
        assert.equal(repository.id, repo.id);
        assert.equal(resource, "pulls");
        assert.equal(number, "71");
        return [{ id: "source", title: "Old name" }, { id: "other-linked", title: "Related by activity" }];
      },
      serial: async (_key, operation) => operation(),
    });
    async function rpc<I, O>(contract: { name: string; input: { parse(input: I): unknown }; output: { parse(output: unknown): O } }, input: I) {
      const handler = handlers.get(contract.name);
      assert.ok(handler, `missing ${contract.name}`);
      return contract.output.parse(await handler(contract.input.parse(input), context));
    }

    const currentTarget = { workspaceId: workspace.id, repository: repo.path };
    const current: RpcOutput<typeof currentPull> = await rpc(currentPull, currentTarget);
    assert.equal(current.branch, branch);
    assert.equal(current.issue?.title, issue.title);
    const create = { workspaceId: workspace.id, repository: repo.path, branch, base: "main", title: issue.title, body: "See issue #42" };
    await assert.rejects(rpc(createPull, create), /最新提交推送/);
    assert.equal(writes.pr, 0);
    git(source, "push", "origin", `HEAD:refs/heads/${branch}`);
    await assert.rejects(rpc(createPull, create), /连接 CNB 失败/);
    assert.equal((await rpc(createPull, create)).number, "71");
    assert.equal(writes.pr, 1);
    assert.ok(workspace.metadata?.[pullKey]);
    assert.equal((await rpc(currentPull, currentTarget)).pulls[0].number, "71");
    assert.equal(detailReads, 0);
    const target = { ...snapshot, workspaceId: main.id };
    const overview = await rpc(pullOverview, target);
    assert.equal(overview.body, "See issue #42");
    assert.deepEqual(overview.workspaces, [
      { id: "source", title: workspace.title }, { id: "other-linked", title: "Related by activity" },
    ]);
    assert.equal(detailReads, 1);

    const worktree = await rpc(openPullWorktree, target);
    assert.equal(worktree.id, "review");
    assert.deepEqual(await rpc(openPullWorktree, target), worktree);
    assert.equal((await rpc(pullChecks, snapshot)).builds[0].id, "cnb-123");
    const failure = { ...target, kind: "stage" as const, build: "cnb-123", pipeline: "pipe-01", stage: "step-01" };
    await assert.rejects(rpc(pullDraft, { ...failure, stage: "different-stage" }), /不在当前构建/);
    const draft = await rpc(pullDraft, failure);
    assert.match(draft.text, /AssertionError.*已遮罩/);
    assert.ok(!draft.text.includes(token));
    assert.deepEqual(draft.agents, [{ id: "original", title: "Original", preferred: true }]);
    stagesAvailable = false;
    const checks = await rpc(pullChecks, snapshot);
    assert.equal(checks.checks.length, 1);
    assert.match(checks.buildError ?? "", /403/);

    assert.equal((await rpc(pullFile, { ...snapshot, path: "src/login.ts" })).patch, patch);
    const review = { ...snapshot, requestId: "submit-review-attempt-1", event: "request_changes" as const, body: "请处理空值", comments: [
      { path: "src/login.ts", side: "right" as const, line: 7, body: "这里会抛异常" },
    ] };
    await assert.rejects(rpc(pullReview, { ...review, comments: [{ ...review.comments[0], line: 25 }] }), /差异范围/);
    await assert.rejects(rpc(pullReview, review), /连接 CNB 失败/);
    await rpc(pullReview, review);
    const feedback = await rpc(pullFeedback, { ...snapshot, page: 1 });
    assert.equal(feedback.items[0].body, "请处理空值");
    const inline = feedback.items.find((item) => item.line === 7);
    assert.ok(inline);
    agentOperation = issueOperation(workspace.projectId, repo.id, "42", "new-workspace-intent");
    Object.assign(workspace.metadata!, {
      [issueKey]: { repositoryId: repo.id, path: repo.path, number: "42", branch, operation: agentOperation },
    });
    const followup = await rpc(pullDraft, { ...snapshot, kind: "feedback", id: inline.id, page: 1 });
    assert.deepEqual(followup.agents, [{ id: "original", title: "Original", preferred: true }]);
    assert.match(followup.text, /src\/login\.ts/);
    assert.match(followup.text, /这里会抛异常/);
    assert.deepEqual(await rpc(requestNpc, snapshot), await rpc(requestNpc, target));
    assert.equal(writes.npc, 1);
    assert.deepEqual((await rpc(pullFeedback, { ...snapshot, page: 1 })).items[0].npc, [{ name: "CodeBuddy", state: "success" }]);
    const inbox = await rpc(pullInbox, { kind: "review", page: 1 });
    assert.equal(inbox.repositories.length, 2);
    assert.equal(inbox.repositories[0].items[0].number, "71");
    assert.equal(inbox.repositories[1].path, second.path);
    assert.equal(inbox.repositories[1].projectId, auto.projectId);
    assert.equal(inbox.repositories[1].workspaceId, auto.id);
    assert.match(inbox.repositories[1].error ?? "", /403/);
    assert.deepEqual(inbox.discoveryIssues.map(({ projectId }) => projectId).sort(), ["ambiguous", "stale-project"]);
    assert.match(inbox.discoveryIssues.find(({ projectId }) => projectId === "ambiguous")!.error, /多个 CNB 仓库/);
    assert.equal((await rpc(pullInbox, { kind: "assigned", page: 1 })).repositories[0].items[0].resource, "issues");
    const openIssues = await rpc(pullInbox, { kind: "issues", page: 1 });
    assert.deepEqual(openIssues.repositories[0].items.map(({ number }) => number), ["42", "43"]);
    assert.equal(openIssues.repositories.length, 2);

    assert.equal(handlers.has("cnb.merge-pull"), false);
    await assert.rejects(rpc(pullReview, { ...review, repository: second.path }), /仓库配对已变化/);
    await assert.rejects(rpc(pullReview, { ...review, head: "a".repeat(40) }), /PR 已有新提交/);
    await assert.rejects(rpc(pullReview, { ...review, base: "a".repeat(40) }), /目标分支已有新提交/);
    assert.ok(pr);
    const created = pr as ReturnType<typeof revision>;
    created.reviewers[0].review_state = "approved";
    assert.equal((await rpc(pullInbox, { kind: "review", page: 1 })).repositories[0].items.length, 0);
    created.state = "merged";
    const afterMerge = await rpc(currentPull, currentTarget);
    assert.deepEqual(afterMerge.pulls, []);
    assert.equal(afterMerge.canCreate, true);
    assert.deepEqual(writes, { pr: 1, review: 1, npc: 1 });
    assert.deepEqual(unexpected, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
