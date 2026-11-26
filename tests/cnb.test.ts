import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cnb, parseIssueUrl, repoPath } from "../server/cnb.ts";
import { describe, findIssue, issueOperation, selectGitRepository, startIssue, type Workspace } from "../server/workspaces.ts";

const repository = { id: "90071992547409939", path: "team/sub/project", webUrl: "https://cnb.cool/team/sub/project" };
const ref = { repositoryId: repository.id, path: repository.path, number: "42" };
const source = { id: "source", projectId: "test-project", projectKind: "git" } as Workspace;
const requestId = "create-issue-first-intent";

test("CNB URLs preserve subgroup paths and reject credential-bearing manual links", () => {
  assert.equal(repoPath("https://cnb.cool/team/sub/project.git"), repository.path);
  assert.equal(repoPath("https://cnb:fake-remote-value@cnb.cool/team/sub/project.git", true), repository.path);
  assert.throws(() => repoPath("https://cnb:fake-remote-value@cnb.cool/team/sub/project.git"), /HTTPS/);
  assert.throws(() => repoPath("https://cnb.cool.evil.example/team/project"), /HTTPS/);
  assert.deepEqual(parseIssueUrl(`${repository.webUrl}/-/issues/42#note`), { path: repository.path, number: "42" });
  assert.equal(parseIssueUrl(`${repository.webUrl}/-/pulls/42`), null);
});

test("API errors preserve details and mask the submitted token", async () => {
  const token = "synthetic-cnb-test-value";
  const client = cnb(token, async (_url, options) => {
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`);
    return Response.json({ message: `Rejected ${token}` }, { status: 403, headers: { "x-request-id": "cn-demo" } });
  });
  await assert.rejects(client.account(), (error: Error) => {
    assert.match(error.message, /HTTP 403.*Rejected.*cn-demo/);
    assert.ok(!error.message.includes(token));
    return true;
  });
});

test("defaults to the CNB canonical path only when both lookups confirm the same repository ID", async () => {
  const alias = "sub/project";
  let canonicalId = repository.id;
  const client = cnb("synthetic-cnb-test-value", async (url) => {
    const path = new URL(String(url)).pathname.slice(1);
    assert.ok(path === alias || path === repository.path);
    return Response.json({
      id: path === alias ? repository.id : canonicalId, path: repository.path, web_url: repository.webUrl,
    });
  });
  assert.deepEqual(await selectGitRepository([alias, repository.path], client.repo), repository);
  canonicalId = "999";
  await assert.rejects(client.repo(alias), /无法确认两个路径指向同一仓库/);
});

test("lists use CNB paging and fetch the requested details", async () => {
  const row = { number: "42", title: "Test", state: "open" };
  const client = cnb("synthetic-cnb-test-value", async (url) => {
    if (String(url).endsWith("/42")) return Response.json({ ...row, number: "43" });
    const request = new URL(String(url));
    assert.equal(request.pathname, `/${repository.path}/-/issues`);
    assert.equal(request.searchParams.get("page"), "2");
    assert.equal(request.searchParams.get("keyword"), "子组 & test");
    return Response.json([row]);
  });
  const page = await client.list(repository, "issues", 2, "子组 & test");
  assert.equal(page.more, false);
  assert.equal(page.items[0].url, `${repository.webUrl}/-/issues/42`);
  await assert.rejects(client.item(repository, "issues", "42"), /不同编号/);
});

test("findIssue rejects duplicate links across pages", async () => {
  const paseo = {
    workspaces: {
      async list({ page }: { page: { cursor?: string } }) {
        return {
          entries: [{ ...source, metadata: { "better-paseo-cnb.issue": ref } }],
          pageInfo: { nextCursor: page.cursor ? null : "second" },
        };
      },
    },
  } as unknown as Parameters<typeof findIssue>[0];
  await assert.rejects(findIssue(paseo, source.projectId, ref.repositoryId, ref.number), /多个工作区/);
});

test("uses Git's resolved remotes and creates a distinct Issue worktree after unlinking", async () => {
  const directory = mkdtempSync(join(tmpdir(), "better-paseo-cnb-issue-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" });
    git("init", "-b", "main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
      "commit", "--allow-empty", "-m", "Test");
    git("remote", "add", "origin", "cnb:team/sub/project.git");
    git("config", "url.https://cnb.cool/.insteadOf", "cnb:");
    git("tag", "main");
    const project = { projectId: source.projectId, projectRootPath: directory, projectKind: "git" } as const;
    const issue = { number: "42", title: "Test Issue", body: "", url: `${repository.webUrl}/-/issues/42` };
    assert.deepEqual(await describe(project), { remotes: [repository.path], branch: "main", branches: ["main"] });
    let created: Workspace | null = null;
    const receipts = new Map<string, Workspace>();
    const paseo = {
      workspaces: {
        async create(input: Parameters<Parameters<typeof startIssue>[0]["workspaces"]["create"]>[0]) {
          assert.ok(input.idempotencyKey);
          const receipt = receipts.get(input.idempotencyKey);
          if (receipt) return { id: receipt.id };
          assert.ok(input.source?.kind === "worktree" && input.source.branchName);
          assert.equal(input.source.cwd, directory);
          assert.equal(input.source.refName, "refs/heads/main");
          const id = `workspace-${receipts.size + 1}`;
          const workspaceDirectory = join(directory, id);
          git("worktree", "add", "-b", input.source.branchName, workspaceDirectory, input.source.refName);
          created = { ...source, id, title: input.title, workspaceDirectory, metadata: input.metadata } as Workspace;
          receipts.set(input.idempotencyKey, created);
          return { id };
        },
        ref(id: string) {
          return { refresh: async () => [...receipts.values()].find((workspace) => workspace.id === id) };
        },
      },
    } as unknown as Parameters<typeof startIssue>[0];
    const load = async () => repository;
    await assert.rejects(startIssue(paseo, project, null, repository, issue, "missing", null, load, requestId), /基准分支已不存在/);
    const result = await startIssue(paseo, project, null, repository, issue, "main", null, load, requestId);
    assert.deepEqual(result, { workspace: { id: "workspace-1", title: "CNB #42 · Test Issue" } });
    assert.ok(created);
    assert.deepEqual(await startIssue(paseo, project, null, repository, issue, "main", null, load, requestId), result);
    assert.deepEqual(await startIssue(paseo, project, created, repository, issue, "main", null, load, "concurrent-intent-2"), result);
    const first = [...receipts.values()][0];
    first.metadata = { "better-paseo-cnb.issue": { ...ref, number: "43" } };
    await assert.rejects(startIssue(paseo, project, null, repository, issue, "main", null, load, requestId), /Issue 关联已变化/);
    const next = await startIssue(paseo, project, null, repository, issue, "main", null, load, "new-intent-after-unlink");
    assert.notEqual(next.workspace.id, result.workspace.id);
    assert.equal(receipts.size, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retries Agent creation using the same worktree and operation key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "better-paseo-cnb-"));
  try {
    function git(...args: string[]) {
      execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" });
    }
    git("init", "-b", "main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Test");
    git("remote", "add", "origin", repository.webUrl);
    const workspace = { ...source, projectRootPath: directory };
    const issue = { number: "42", title: "Test Issue", body: "External text", url: `${repository.webUrl}/-/issues/42` };
    const load = async () => repository;
    let created: Workspace | null = null;
    let worktreeCalls = 0;
    const agentKeys: string[] = [];
    let agentReady = false;
    let firstTurnFailed = false;
    let resent = 0;
    let agentLabel = issueOperation(workspace.projectId, repository.id, issue.number, requestId);
    const paseo = {
      workspaces: {
        async create(input: { metadata: Workspace["metadata"]; idempotencyKey: string; source: { refName: string; branchName: string } }) {
          worktreeCalls++;
          assert.match(input.idempotencyKey, /^better-paseo-cnb:workspace:/);
          assert.equal(input.source.refName, "refs/heads/main");
          const workspaceDirectory = join(directory, "created");
          git("worktree", "add", "-b", input.source.branchName, workspaceDirectory, input.source.refName);
          created = { ...workspace, id: "created", workspaceDirectory, metadata: input.metadata };
          return { id: created.id };
        },
        ref(workspaceId: string) {
          assert.equal(workspaceId, "created");
          return { refresh: async () => created, agents: {
            async create({ idempotencyKey, prompt, labels }: { idempotencyKey: string; prompt: string; labels: Record<string, string> }) {
              assert.equal(labels["better-paseo-cnb.operation"], agentLabel);
              agentKeys.push(idempotencyKey);
              assert.match(prompt, /External text/);
              if (agentKeys.length === 1) throw new Error("Synthetic startup error");
              agentReady = true;
              return { id: "agent" };
            },
          } };
        },
      },
      agents: {
        async list({ filter }: { filter: { labels: Record<string, string> } }) {
          assert.equal(filter.labels["better-paseo-cnb.operation"], agentLabel);
          return { entries: agentReady ? [{ agent: { id: "agent", workspaceId: "created",
            status: firstTurnFailed ? "error" : "idle", lastUserMessageAt: firstTurnFailed ? null : "now",
          } }] : [] };
        },
        ref(id: string) {
          assert.equal(id, "agent");
          return { async send(prompt: string, options: { messageId: string }) {
            assert.match(prompt, /External text/);
            assert.match(options.messageId, /:retry$/);
            resent++;
          } };
        },
      },
    } as unknown as Parameters<typeof startIssue>[0];
    const start = (existing: Workspace | null) => startIssue(paseo, workspace, existing, repository, issue, "main", "test/model", load, requestId);
    await assert.rejects(start(null), /工作区 created.*Synthetic startup error/);
    assert.ok(created);
    const worktree = join(directory, "created");
    git("-C", worktree, "switch", "-c", "other-task");
    await assert.rejects(start(created), /other-task.*切回关联分支/);
    assert.equal(agentKeys.length, 1);
    git("-C", worktree, "switch", "-");
    assert.equal((await start(created)).agentId, "agent");
    assert.equal((await start(created)).agentId, "agent");
    assert.equal(worktreeCalls, 1);
    assert.equal(agentKeys.length, 2);
    assert.equal(agentKeys[0], agentKeys[1]);
    firstTurnFailed = true;
    git("-C", worktree, "switch", "other-task");
    await assert.rejects(start(created), /other-task.*切回关联分支/);
    assert.equal(resent, 0);
    git("-C", worktree, "switch", "-");
    assert.equal((await start(created)).agentId, "agent");
    assert.equal(resent, 1);
    assert.equal(agentKeys.length, 2);
    agentLabel = issueOperation(workspace.projectId, repository.id, issue.number);
    const legacyBranch = `cnb/issue-42-${agentLabel.slice(0, 8)}`;
    git("-C", worktree, "switch", "-c", legacyBranch);
    const legacy = { ...(created as Workspace), metadata: { "better-paseo-cnb.issue": { ...ref, branch: legacyBranch } } };
    created = legacy;
    firstTurnFailed = false;
    assert.equal((await start(legacy)).agentId, "agent");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
