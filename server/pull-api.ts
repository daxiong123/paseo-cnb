import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { number, slug, type resource as resourceSchema } from "../shared/cnb.ts";
import { branchName, buildId, sha, side, type inboxKind } from "../shared/pulls.ts";
import type { Repository, Send } from "./cnb.ts";

export const row = z.object({ number, title: z.string(), state: z.string(), is_merged: z.boolean().optional() });
const pullRef = z.object({ ref: branchName, sha, repo: z.object({ path: slug }) }).transform((value) => ({
  branch: value.ref.replace(/^refs\/heads\//, ""), sha: value.sha, path: value.repo.path,
}));
const pullDetail = row.extend({
  head: pullRef, base: pullRef,
  body: z.string().nullish(),
  blocked_on: z.string().nullish(),
  mergeable_state: z.string().nullish(),
  is_wip: z.boolean(),
  reviewers: z.array(z.object({ user: z.object({ username: z.string() }), review_state: z.string() })).nullish(),
});
const check = z.object({ context: z.string(), state: z.string(), description: z.string().nullish() });
const checks = z.object({ sha, state: z.string(), statuses: z.array(check).nullish() });
const stage = z.object({ id: buildId, name: z.string(), status: z.string() });
const pipelines = z.object({
  pipelinesStatus: z.record(z.string(), z.object({ id: buildId, stages: z.array(stage).nullish() })).nullish(),
});
const stageDetails = stage.extend({ content: z.array(z.string()).nullish(), error: z.string().nullish() });
const builds = z.object({
  total: z.number().int().nonnegative(),
  data: z.array(z.object({ sn: buildId, sha, slug, title: z.string().nullish(), event: z.string(), status: z.string() })).nullish(),
});
const apiFile = z.object({ filename: z.string().min(1).max(4096), status: z.string(), patch: z.string().nullish() });
const commentId = z.string().regex(/^\d+$/);
const comments = z.object({
  id: commentId, body: z.string().nullish(),
  author: z.object({ username: z.string(), nickname: z.string().nullish() }),
  statuses: z.object({
    npc: z.array(z.object({
      key: z.object({ name: z.string() }),
      statuses: z.array(z.object({ state: z.string() })).nullish(),
    })).nullish(),
  }).nullish(),
});
const review = comments.extend({ state: z.string() });
const inline = comments.extend({
  path: z.string(), end_line: z.number().int(), end_side: side.or(z.literal("")).nullish(),
  commit_hash: sha.or(z.literal("")).nullish(),
});
const pageSize = 20;
const feedbackPageSize = 10;
const operationMarker = /(?:^|\n\n)<!-- better-paseo-cnb:(?:review:[a-zA-Z0-9_-]{16,100}|npc:[0-9a-f]{40,64}) -->$/;

export function entry(repo: Repository, resource: z.infer<typeof resourceSchema>, item: z.infer<typeof row>) {
  return {
    number: item.number, title: item.title, state: item.is_merged ? "merged" : item.state,
    url: `${repo.webUrl}/-/${resource}/${item.number}`,
  };
}

function overview(repo: Repository, item: z.infer<typeof pullDetail>) {
  if (item.base.path !== repo.path) throw new Error("CNB 返回的 PR 目标仓库与请求仓库不一致");
  return {
    ...entry(repo, "pulls", item), body: item.body ?? "", head: item.head, base: item.base, draft: item.is_wip,
    blockedOn: item.blocked_on ?? "", mergeableState: item.mergeable_state ?? "",
  };
}

function pullPath(repo: Repository, id?: string) {
  return `/${slug.parse(repo.path)}/-/pulls${id ? `/${number.parse(id)}` : ""}`;
}

function normalizeComment(item: z.infer<typeof comments>, prefix: string) {
  return {
    id: `${prefix}:${item.id}`, author: item.author.nickname || item.author.username,
    body: (item.body ?? "").replace(operationMarker, ""),
    npc: (item.statuses?.npc ?? []).flatMap((group) =>
      (group.statuses ?? []).map(({ state }) => ({ name: group.key.name, state }))),
  };
}

export function pullApi(send: Send, token: string) {
  async function readPull(repo: Repository, id: string) {
    const data = await send(pullPath(repo, id), pullDetail);
    if (data.number !== id) throw new Error("CNB 返回了不同编号的 PR");
    return data;
  }

  async function* pages<T extends { id: string }>(path: string, schema: z.ZodType<T[]>) {
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      const items = await send(`${path}?page=${page}&page_size=100`, schema);
      for (const item of items) {
        if (seen.has(item.id)) throw new Error("CNB 返回了重复的评论或评审分页结果");
        seen.add(item.id);
      }
      yield items;
      if (items.length < 100) return;
    }
  }
  return {
    async pull(repo: Repository, id: string) { return overview(repo, await readPull(repo, id)); },
    async findOpenPulls(repo: Repository, branch: string) {
      const seen = new Set<string>();
      const matches = [];
      for (let page = 1; ; page++) {
        const entries = await send(`${pullPath(repo)}?state=open&page=${page}&page_size=100`, z.array(pullDetail));
        for (const item of entries) {
          if (seen.has(item.number)) throw new Error("CNB 返回了重复的 PR 分页结果");
          seen.add(item.number);
          if (item.head.path === repo.path && item.head.branch === branch) matches.push(overview(repo, item));
        }
        if (entries.length < 100) break;
      }
      return matches;
    },
    async newPull(repo: Repository, fields: { title: string; body: string; head: string; base: string }) {
      const result = await send(pullPath(repo), pullDetail, {
        body: JSON.stringify({ ...fields, head_repo: repo.path }),
      });
      return overview(repo, result);
    },
    async pullChecks(repo: Repository, id: string, head: string) {
      const result = await send(`${pullPath(repo, id)}/commit-statuses`, checks);
      if (result.sha !== head) throw new Error("检查对应的提交已变化，请刷新 PR");
      return { state: result.state, checks: (result.statuses ?? []).map((item) => ({
        name: item.context, description: item.description ?? "", state: item.state,
      })) };
    },
    async failureBuilds(repo: Repository, head: string) {
      const result = await send(`/${repo.path}/-/build/logs?sha=${sha.parse(head)}&status=error&page=1&page_size=20`, builds);
      const items = result.data ?? [];
      if (items.some((item) => item.sha !== head || item.slug !== repo.path)) {
        throw new Error("CNB 返回的构建与请求的仓库或提交不一致");
      }
      return {
        builds: items.map((item) => ({ id: item.sn, title: item.title || item.sn, state: item.status, event: item.event })),
        moreBuilds: result.total > items.length,
      };
    },
    async buildStages(repo: Repository, build: string) {
      const result = await send(`/${repo.path}/-/build/status/${buildId.parse(build)}`, pipelines);
      return Object.values(result.pipelinesStatus ?? {}).flatMap((pipeline) =>
        (pipeline.stages ?? []).map((stage) => ({ id: stage.id, name: stage.name, state: stage.status, pipeline: pipeline.id })));
    },
    async stageLog(repo: Repository, build: string, pipeline: string, stage: string) {
      const path = [build, pipeline, stage].map((part) => buildId.parse(part)).join("/");
      const result = await send(`/${repo.path}/-/build/logs/stage/${path}`, stageDetails);
      if (result.id !== stage) throw new Error("CNB 返回了不同编号的流水线阶段");
      const clean = (value: string) => stripVTControlCharacters(value).replaceAll(token, "[已遮罩]");
      const lines = result.content ?? [];
      const tail = clean(lines.slice(-80).join("\n"));
      return {
        stage: result.name, state: result.status, error: clean(result.error ?? "").slice(0, 1000),
        log: tail.slice(-6000), truncated: lines.length > 80 || tail.length > 6000,
      };
    },
    async pullFeedback(repo: Repository, id: string, page: number) {
      const path = pullPath(repo, id);
      const query = `?page=${page}&page_size=${feedbackPageSize}`;
      const [posts, reviews] = await Promise.all([
        send(`${path}/comments${query}`, z.array(comments)),
        send(`${path}/reviews${query}`, z.array(review)),
      ]);
      const resolved = await Promise.all(reviews.filter((item) => item.state !== "pending").map(async (item) => {
        const items = [{ ...normalizeComment(item, "review"), state: item.state }];
        const lines = [];
        for await (const comments of pages(`${path}/reviews/${item.id}/comments`, z.array(inline))) {
          for (const line of comments) lines.push({
            ...normalizeComment(line, `inline:${item.id}`), path: line.path,
            line: line.end_line > 0 ? line.end_line : undefined,
            side: line.end_side || undefined, commit: line.commit_hash || undefined,
          });
        }
        return [...items, ...lines];
      }));
      return {
        items: [...posts.map((item) => normalizeComment(item, "comment")), ...resolved.flat()],
        more: posts.length === feedbackPageSize || reviews.length === feedbackPageSize,
      };
    },
    async pullFiles(repo: Repository, id: string) {
      const files = await send(`${pullPath(repo, id)}/files`, z.array(apiFile));
      return files.map((file) => ({ path: file.filename, status: file.status, patch: file.patch ?? "" }));
    },
    async submitReview(repo: Repository, id: string, userReview: {
      event: "comment" | "approve" | "request_changes"; body: string;
      comments: { path: string; side: z.infer<typeof side>; line: number; body: string }[];
      requestId: string;
    }, username: string, verify: () => Promise<unknown>) {
      const path = `${pullPath(repo, id)}/reviews`;
      const marker = `<!-- better-paseo-cnb:review:${userReview.requestId} -->`;
      for await (const items of pages(path, z.array(review))) {
        if (items.some((item) => item.author.username === username && item.body?.trimEnd().endsWith(marker))) return {};
      }
      await verify();
      return send(path, z.object({}), {
        empty: true,
        body: JSON.stringify({
          event: userReview.event, body: `${userReview.body}\n\n${marker}`,
          comments: userReview.comments.map(({ path, side, line, body }) => ({
            path, body, subject_type: "line", start_side: side, end_side: side, start_line: line, end_line: line,
          })),
        }),
      });
    },
    async requestNpcReview(repo: Repository, id: string, head: string, username: string, verify: () => Promise<unknown>) {
      const body = `@CodeBuddy 请审查此 PR 在提交 ${head} 的代码变更，回复评审意见，无需修改代码。\n\n<!-- better-paseo-cnb:npc:${head} -->`;
      let count = 0;
      for await (const items of pages(`${pullPath(repo, id)}/comments`, z.array(comments))) {
        const existing = items.find((item) => item.author.username === username && item.body === body);
        if (existing) return { id: existing.id };
        count += items.length;
      }
      if (count >= 100) throw new Error("此 PR 的评论即将超过 CNB 的 NPC 触发上限");
      await verify();
      const comment = await send(`${pullPath(repo, id)}/comments`, comments, {
        body: JSON.stringify({ body, work_mode: false }),
      });
      return { id: comment.id };
    },
    async inbox(repo: Repository, kind: z.infer<typeof inboxKind>, username: string, page: number) {
      const resource: z.infer<typeof resourceSchema> = kind === "issues" || kind === "assigned" ? "issues" : "pulls";
      const query = new URLSearchParams({ state: "open", page: String(page), page_size: String(pageSize) });
      if (kind === "assigned") query.set("assignees", username);
      if (kind === "authored") query.set("authors", username);
      if (kind === "review") query.set("reviewers", username);
      const items = await send(`/${repo.path}/-/${resource}?${query}`, z.array(row));
      const pending = kind !== "review" ? items : (await Promise.all(items.map(async (item) => {
        const detail = await readPull(repo, item.number);
        return detail.reviewers?.some(({ user, review_state: state }) =>
          user.username === username && ["pending", "commented", "dismissed"].includes(state)) ? item : null;
      }))).filter((item) => item !== null);
      return { items: pending.map((item) => ({ ...entry(repo, resource, item), resource })), more: items.length === pageSize };
    },
  };
}
