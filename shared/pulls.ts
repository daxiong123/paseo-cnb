import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { association, number, requestId, resource, slug } from "./cnb.ts";

export const pullKey = "better-paseo-cnb.pull";
export const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const pullLink = association.extend({ reviewSha: sha.optional() });
export const branchName = z.string().min(1).max(512);
export const buildId = z.string().max(200).regex(/^[\w-]+$/);
export const side = z.enum(["left", "right"]);
export const entry = z.object({ number, title: z.string(), state: z.string(), url: z.url() });
export const revision = z.object({ branch: branchName, sha, path: slug });
export const pull = entry.extend({
  head: revision,
  base: revision,
  blockedOn: z.string(),
  mergeableState: z.string(),
  draft: z.boolean(),
});
const workspace = z.object({ workspaceId: z.string().min(1) });
const target = workspace.extend({ number, repository: slug });
const snapshot = target.extend({ head: sha, base: sha });
const page = z.number().int().min(1);
const feedback = z.object({
  id: z.string(), author: z.string(), body: z.string(), state: z.string().optional(),
  path: z.string().optional(), line: z.number().int().positive().optional(), side: side.optional(),
  commit: sha.optional(), npc: z.array(z.object({ name: z.string(), state: z.string() })),
});
const filePath = z.string().min(1).max(4096);
export const file = z.object({ path: filePath, status: z.string(), patch: z.string(), truncated: z.boolean() });
const check = z.object({ name: z.string(), description: z.string(), state: z.string() });
const build = z.object({ id: buildId, title: z.string(), state: z.string(), event: z.string() });
const stage = z.object({ id: buildId, pipeline: buildId, name: z.string(), state: z.string() });
const draft = z.object({
  text: z.string(),
  agents: z.array(z.object({ id: z.string(), title: z.string(), preferred: z.boolean() })),
});

export const currentPull = defineRpc({
  name: "cnb.current-pull",
  input: workspace.extend({ repository: slug }),
  output: z.object({
    branch: branchName.nullable(), pulls: z.array(pull),
    issue: z.object({ number, title: z.string(), url: z.url() }).nullable(),
    canCreate: z.boolean(), reviewSha: sha.optional(),
  }),
});
export const createPull = defineRpc({
  name: "cnb.create-pull",
  input: workspace.extend({
    branch: branchName, base: branchName, title: z.string().trim().min(1).max(255),
    body: z.string().max(20_000), repository: slug,
  }),
  output: pull,
});
export const pullOverview = defineRpc({
  name: "cnb.pull-overview",
  input: target,
  output: pull.extend({ body: z.string(), workspaces: z.array(z.object({ id: z.string(), title: z.string() })) }),
});
export const pullChecks = defineRpc({
  name: "cnb.pull-checks",
  input: snapshot,
  output: z.object({
    state: z.string(), checks: z.array(check), builds: z.array(build), moreBuilds: z.boolean(),
    buildError: z.string().nullable(),
  }),
});
export const pullStages = defineRpc({
  name: "cnb.pull-stages",
  input: snapshot.extend({ build: buildId }),
  output: z.array(stage),
});
export const pullFeedback = defineRpc({
  name: "cnb.pull-feedback",
  input: snapshot.extend({ page }),
  output: z.object({ items: z.array(feedback), more: z.boolean() }),
});
export const pullFiles = defineRpc({
  name: "cnb.pull-files",
  input: snapshot,
  output: z.array(z.object({ path: filePath, status: z.string() })),
});
export const pullFile = defineRpc({
  name: "cnb.pull-file",
  input: snapshot.extend({ path: filePath }),
  output: file,
});
export const pullDraft = defineRpc({
  name: "cnb.pull-draft",
  input: z.discriminatedUnion("kind", [
    snapshot.extend({ kind: z.literal("check"), index: z.number().int().nonnegative(), name: z.string() }),
    snapshot.extend({ kind: z.literal("stage"), build: buildId, pipeline: buildId, stage: buildId }),
    snapshot.extend({ kind: z.literal("feedback"), page, id: z.string().min(1).max(250) }),
  ]),
  output: draft,
});
export const pullReview = defineRpc({
  name: "cnb.pull-review",
  input: snapshot.extend({
    requestId,
    event: z.enum(["comment", "approve", "request_changes"]),
    body: z.string().trim().max(20_000),
    comments: z.array(z.object({
      path: filePath, side, line: z.number().int().positive(), body: z.string().trim().min(1).max(5000),
    })).max(20),
  }).refine(({ event, body, comments }) => event === "approve" || body || comments.length, {
    message: "请输入评审意见或添加逐行评论",
  }),
  output: z.object({}),
});
export const openPullWorktree = defineRpc({
  name: "cnb.pull-worktree",
  input: snapshot,
  output: z.object({ id: z.string(), title: z.string() }),
});
export const requestNpc = defineRpc({
  name: "cnb.pull-npc",
  input: snapshot,
  output: z.object({ id: z.string() }),
});
export const inboxKind = z.enum(["issues", "review", "authored", "assigned"]);
export const pullInbox = defineRpc({
  name: "cnb.inbox",
  input: z.object({ kind: inboxKind, page }),
  output: z.object({
    username: z.string(),
    discoveryIssues: z.array(z.object({
      projectId: z.string(), title: z.string(), workspaceId: z.string().nullable(), error: z.string(),
    })),
    repositories: z.array(z.object({
      path: slug, projectId: z.string().min(1), workspaceId: z.string().nullable(), error: z.string().nullable(),
      items: z.array(entry.extend({ resource })), more: z.boolean(),
    })),
  }),
});

export function failed(state: string) {
  return ["error", "failure", "failed", "timed_out"].includes(state.toLowerCase());
}

export function diffLines(patch: string) {
  let left = 0;
  let right = 0;
  let leftRemaining = 0;
  let rightRemaining = 0;
  return patch.split("\n").map((text) => {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (header) {
      left = Number(header[1]);
      leftRemaining = Number(header[2] ?? 1);
      right = Number(header[3]);
      rightRemaining = Number(header[4] ?? 1);
    }
    if (text.startsWith("-") && leftRemaining > 0) {
      leftRemaining--;
      return { text, left: left++, right: null };
    }
    if (text.startsWith("+") && rightRemaining > 0) {
      rightRemaining--;
      return { text, left: null, right: right++ };
    }
    if (text.startsWith(" ") && leftRemaining > 0 && rightRemaining > 0) {
      leftRemaining--;
      rightRemaining--;
      return { text, left: left++, right: right++ };
    }
    return { text, left: null, right: null };
  });
}
