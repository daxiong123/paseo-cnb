import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { issueKey, shareKey } from "../shared/cnb.ts";
import { readActivityState, relatedWorkspaces, synchronizeActivity } from "../server/activity.ts";
import { cnb, resolveManualRepository } from "../server/cnb.ts";
import { bucketName, collectRefs, floorHour, hour, parseEvents, readActivity } from "../server/event-format.ts";
import type { Workspace } from "../server/workspaces.ts";

const repo = { id: "90071992547409939", path: "team/one/repo", webUrl: "https://cnb.cool/team/one/repo" };
const cross = { id: "90071992547409941", path: "team/other", webUrl: "https://cnb.cool/team/other" };
const url = "https://paseo.example.invalid/project/workspace";
const now = Date.parse("2026-11-25T04:15:00Z");
const prId = "900719925474099381";
const workspace = {
  id: "workspace", name: "CNB issue 42", projectId: "project", archivingAt: null,
  metadata: {
    [issueKey]: { repositoryId: repo.id, path: repo.path, number: "42" },
    [shareKey]: url,
  },
} as unknown as Workspace;
const foreign = {
  ...workspace, id: "foreign", projectId: "cross",
  metadata: { [issueKey]: { repositoryId: cross.id, path: cross.path, number: "42" } },
} as Workspace;

function pr(id = prId, created = now - 10_000) {
  return {
    id, repo: { id: repo.id, path: repo.path }, type: "PullRequestEvent",
    created_at: new Date(created).toISOString(),
    pull_request: { number: 90, title: "修复#42", body: `另见 ${cross.webUrl}/-/issues/42`, head: { ref: "fix/issue-60" } },
  };
}

test("event redirects keep the CNB bearer on api.cnb.cool and preserve full integer IDs", async () => {
  const requests: string[] = [];
  const client = cnb("mock-read-credential", async (url, options) => {
    const target = new URL(String(url));
    requests.push(target.hostname);
    if (target.hostname === "api.cnb.cool") {
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer mock-read-credential");
      assert.equal(target.pathname, "/events/team/one/repo/-/2026-11-25-4");
      assert.equal(options?.redirect, "manual");
      return new Response(null, { status: 302, headers: {
        location: "https://bucket.cos.ap-guangzhou.myqcloud.com/events.json?signature=temporary",
      } });
    }
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    assert.equal(options?.redirect, "error");
    const event = JSON.stringify(pr()).replace(`"${prId}"`, prId).replace(`"${repo.id}"`, repo.id);
    return new Response(`[${event}]`, { headers: { "content-type": "application/json" } });
  });
  assert.equal(parseEvents(await client.events(repo, bucketName(now)), repo)[0].id, prId);
  assert.deepEqual(requests, ["api.cnb.cool", "bucket.cos.ap-guangzhou.myqcloud.com"]);
});

test("events reject unsafe redirects and distinguish an absent bucket from an access failure", async () => {
  const unsafe = cnb("mock", async () => new Response(null, {status: 302, headers: {location: "http://cnb.cool/file"}}));
  await assert.rejects(unsafe.events(repo, bucketName(now)), /不受支持的存储地址/);
  const missing = cnb("mock", async (input) => String(input).startsWith("https://api.cnb.cool")
    ? new Response(null, {status: 302, headers: {location: "https://bucket.cos.ap-guangzhou.myqcloud.com/file"}})
    : new Response("<Error><Code>NoSuchKey</Code></Error>", {status: 404}));
  assert.deepEqual(await missing.events(repo, bucketName(now)), []);
  const forbidden = cnb("mock", async () => Response.json({message:"denied"}, {status: 403}));
  await assert.rejects(forbidden.events(repo, bucketName(now)), /403/);
});

test("references are scoped to the event repository except explicit CNB links", async () => {
  assert.deepEqual(collectRefs(repo.path, [
    "修复#42，见 https://others.example/notes#456 和 team/other#18。",
    `另见 (${cross.webUrl}/-/issues/42) 以及 ${cross.webUrl}/-/pulls/90`,
  ], "refs/heads/cnb/issue-60-af32"), [
    { path: repo.path, number: "42" },
    { path: cross.path, number: "42" },
    { path: repo.path, number: "60" },
  ]);
  const own = {
    id: "3", type: "IssueCommentEvent", repo, created_at: new Date(now).toISOString(),
    issue: { number: 42, title: "Issue" }, comment: { body: `<!-- better-paseo-cnb:${"a".repeat(64)} -->\n[Open](${url})` },
  };
  const client = cnb("mock", async () => { throw new Error("must not fetch"); });
  assert.equal(await readActivity(parseEvents([own], repo)[0], client, repo), null);
});

test("bucket replay after partial failure preserves event progress and cross-repo associations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cnb-activity-test-"));
  try {
    const file = join(dir, "state.json");
    const since = now - 3 * hour;
    let fail = true;
    const client = cnb("read", async (input) => {
      const filename = String(input).split("/").at(-1);
      if (filename !== bucketName(floorHour(since))) return Response.json([]);
      const old = pr("old", since + 1000);
      const event = {
        id: "901", type: "IssueEvent", repo, created_at: new Date(since + 5000).toISOString(),
        issue: { number: 42, title: "Test Issue", ...(fail ? {} : {body: "Fixed payload"}) },
      };
      return Response.json([{...old, id: "900"}, event]);
    });
    const args = {
      file, repo, config: { repositoryId: repo.id, since }, projects: async () => ({ project: repo, cross }),
      workspaces: [workspace, foreign], client: async () => client, canPublish: async () => false,
      retry: false, now,
    };
    const failed = await synchronizeActivity(args);
    assert.match(failed.error ?? "", /响应字段/);
    assert.equal(failed.recent.length, 1);
    fail = false;
    const next = await synchronizeActivity(args);
    assert.equal(next.error, null);
    assert.equal(next.nextHour, floorHour(since) + 2 * hour);
    assert.deepEqual(next.recent.map((entry) => entry.id), ["901", "900"]);
    const related = await relatedWorkspaces(await readActivityState(file), { resource: "pulls", number: "90" },
      async (id) => [workspace, foreign].find((entry) => entry.id === id) ?? null);
    assert.deepEqual(related.map((result) => result.id), ["workspace", "foreign"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uncertain CNB response is reconciled against the author's existing comment before posting again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cnb-backlink-test-"));
  try {
    const file = join(dir, "state.json");
    const config = { repositoryId: repo.id, since: now - 20_000, commentsSince: now - 20_000, commentsUsername: "owner" };
    const remote: { id: string; body: string; author: { username: string } }[] = [];
    let posts = 0;
    const client = cnb("synthetic", async (input, init) => {
      if (String(input).includes("/events/")) return Response.json([pr()]);
      if (String(input).endsWith("/user")) return Response.json({username:"owner"});
      if (init?.method === "POST") {
        assert.equal(String(input), "https://api.cnb.cool/team/one/repo/-/pulls/90/comments");
        const { body } = JSON.parse(String(init?.body));
        assert.match(body, /paseo.example.invalid\/project\/workspace/);
        assert.match(body, /^<!-- better-paseo-cnb:[a-f\d]{64} -->/);
        posts++;
        remote.push({id: "123", body, author: {username:"owner"}});
        throw new Error("synthetic connection loss after recording comment");
      }
      return Response.json(remote);
    });
    const args = { file, repo, config, projects: async () => ({ project: repo }), workspaces: [workspace],
      client: async () => client, canPublish: async () => true, retry: false, now };
    const first = await synchronizeActivity(args);
    assert.equal(first.comments.uncertain, 1);
    assert.match(first.error ?? "", /连接 CNB 失败/);
    const resumed = await synchronizeActivity(args);
    assert.equal(resumed.comments.sent, 1);
    assert.equal(resumed.error, null);
    assert.equal(resumed.recent.length, 1);
    assert.equal(posts, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("peer identity failure preserves the cursor until the referenced repository is verified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cnb-peer-test-"));
  try {
    const file = join(dir, "state.json");
    let peer = { ...cross, id: "123" };
    let reads = 0;
    const args = {
      file, repo, config: { repositoryId: repo.id, since: now - 20_000 }, retry: false, now,
      projects: async () => ({ project: repo, cross: await resolveManualRepository(cross, async () => peer) }),
      workspaces: [foreign], canPublish: async () => false,
      client: async () => cnb("synthetic", async () => { reads++; return Response.json([pr()]); }),
    };
    const failed = await synchronizeActivity(args);
    assert.match(failed.error ?? "", /路径已指向其他 CNB 仓库/);
    assert.equal(failed.nextHour, null);
    assert.equal(reads, 0);
    peer = cross;
    const resumed = await synchronizeActivity(args);
    assert.equal(resumed.error, null);
    assert.deepEqual(resumed.recent[0]?.workspaces.map((ws) => ws.id), [foreign.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a denied backlink does not block the next target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cnb-queue-test-"));
  try {
    const first = pr("1");
    const second = { ...pr("2"), pull_request: { ...first.pull_request, number: 91 } };
    const attempts: string[] = [];
    const args = {
      file: join(dir, "state.json"), repo, workspaces: [workspace], retry: false, now,
      config: { repositoryId: repo.id, since: now - 20_000, commentsSince: now - 20_000, commentsUsername: "owner" },
      projects: async () => ({ project: repo }), canPublish: async () => true,
      client: async () => cnb("synthetic", async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.startsWith("/events/")) return Response.json([first, second]);
        if (path === "/user") return Response.json({ username: "owner" });
        if (init?.method !== "POST") return Response.json([]);
        attempts.push(path);
        if (path.endsWith("/90/comments")) return Response.json({}, { status: 403 });
        return Response.json({ id: "42", body: "ok", author: { username: "owner" } });
      }),
    };
    assert.match((await synchronizeActivity(args)).error ?? "", /403/);
    assert.equal((await synchronizeActivity({ ...args, now: now + 60_000 })).comments.sent, 1);
    assert.deepEqual(attempts, [90, 91].map((number) => `/${repo.path}/-/pulls/${number}/comments`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unconfirmed writes stay pending until explicitly retried, and revoked approval stops publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cnb-retry-test-"));
  try {
    const file = join(dir, "state.json");
    let approved = false;
    let posts = 0;
    let username = "switched-user";
    const client = cnb("synthetic", async (input, init) => {
      if (String(input).includes("/events/")) return Response.json([pr()]);
      if (String(input).endsWith("/user")) return Response.json({username});
      if (init?.method !== "POST") return Response.json([]);
      if (++posts === 1) throw new Error("synthetic loss before commit");
      const { body } = JSON.parse(String(init.body));
      return Response.json({id: "124", body, author: {username:"owner"}}, {status: 201});
    });
    const args = {
      file, client: async () => client, repo, projects: async () => ({ project: repo }), workspaces: [workspace], now, retry: false,
      config: { repositoryId: repo.id, since: now - 20_000, commentsSince: now - 20_000, commentsUsername: "owner" },
      canPublish: async () => approved,
    };
    const switched = await synchronizeActivity(args);
    assert.match(switched.error ?? "", /账号已切换/);
    assert.equal(switched.comments.pending, 1);
    assert.equal(posts, 0);
    username = "owner";
    assert.equal((await synchronizeActivity(args)).comments.pending, 1);
    assert.equal(posts, 0);
    approved = true;
    assert.equal((await synchronizeActivity(args)).comments.uncertain, 1);
    assert.equal((await synchronizeActivity({ ...args, now: now + 70_000 })).comments.uncertain, 1);
    assert.equal(posts, 1);
    const retried = await synchronizeActivity({ ...args, now: now + 70_000, retry: true });
    assert.equal(retried.comments.sent, 1);
    assert.equal(retried.error, null);
    assert.equal(posts, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
