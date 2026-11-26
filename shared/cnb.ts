import { defineAttachmentSource, defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const issueKey = "better-paseo-cnb.issue";
export const shareKey = "better-paseo-cnb.share-url";
export const slug = z.string().max(512).regex(/^[\w-][\w.-]*(?:\/[\w-][\w.-]*)+$/);
export const number = z.string().regex(/^[1-9]\d{0,19}$/);
export const resource = z.enum(["issues", "pulls"]);
export const repository = z.object({ id: z.string().min(1), path: slug, webUrl: z.url() })
  .refine((repo) => repo.webUrl === `https://cnb.cool/${repo.path}`, { path: ["webUrl"], message: "仓库链接与路径不一致" });
export const automation = z.object({
  repositoryId: z.string().min(1),
  since: z.number().int().positive(),
  commentsSince: z.number().int().positive().optional(),
  commentsUsername: z.string().min(1).optional(),
});
export const preferences = defineSettings({
  id: "repositories",
  scope: "host",
  version: 1,
  schema: z.object({
    projects: z.record(z.string(), repository).default({}),
    automation: z.record(z.string(), automation).default({}),
  }),
});
const workspaceId = z.string().min(1);
const workspace = z.object({ workspaceId });
const entry = z.object({ number, title: z.string(), state: z.string(), url: z.url() });
const linked = z.object({ id: workspaceId, title: z.string() });
export const shareUrl = z.url().refine((value) => /^https:\/\/[\w.-]+(?::\d+)?(?:\/[^\s()[\]?#<>]*)?$/.test(value), {
  message: "请填写团队可访问的 HTTPS 链接，链接中不应包含账号、查询参数或片段",
});
export const association = z.object({
  repositoryId: z.string().min(1),
  path: slug,
  number,
  branch: z.string().optional(),
  operation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const requestId = z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/);

export function newRequestId(): string {
  return [Date.now(), Math.floor(Math.random() * 2 ** 32), Math.floor(Math.random() * 2 ** 32)]
    .map((part) => part.toString(36).padStart(7, "0")).join("-");
}

export const connection = defineRpc({
  name: "cnb.cli-connection",
  input: z.object({}).strict(),
  output: z.object({ username: z.string(), cliVersion: z.string() }),
});

export const workspaceContext = defineRpc({
  name: "cnb.workspace",
  input: workspace,
  output: z.object({
    projectId: z.string(),
    remotes: z.array(slug),
    branch: z.string().nullable(),
    branches: z.array(z.string()),
    issue: association.nullable(),
    shareUrl: shareUrl.nullable(),
    repository: repository.nullable(),
    repositoryError: z.string().nullable(),
  }),
});

export const inspectRepository = defineRpc({
  name: "cnb.repository",
  input: workspace.extend({ url: z.string().trim().max(1024) }),
  output: repository,
});

export const listItems = defineRpc({
  name: "cnb.list",
  input: workspace.extend({
    resource,
    repository: slug,
    page: z.number().int().min(1),
    keyword: z.string().trim().max(255),
  }),
  output: z.object({ items: z.array(entry), more: z.boolean() }),
});

export const getItem = defineRpc({
  name: "cnb.item",
  input: workspace.extend({ resource: z.literal("issues"), number, repository: slug }),
  output: entry.extend({ body: z.string(), workspace: linked.nullable(), related: z.array(linked) }),
});

const projectIssue = z.object({ projectId: z.string().min(1), repository: slug, number });
export const inboxIssue = defineRpc({
  name: "cnb.inbox-issue",
  input: projectIssue,
  output: entry.extend({
    body: z.string(),
    repositoryId: z.string().min(1),
    workspace: linked.nullable(),
    branches: z.array(z.string()),
    base: z.string().nullable(),
    workspaceError: z.string().nullable(),
  }),
});

export const createIssueWorkspace = defineRpc({
  name: "cnb.issue-workspace",
  input: projectIssue.extend({ repositoryId: z.string().min(1), base: z.string().min(1).max(512), requestId }),
  output: z.object({ workspace: linked }),
});

export const changeShareUrl = defineRpc({
  name: "cnb.share-url",
  input: workspace.extend({ url: shareUrl.nullable(), repositoryId: z.string().min(1) }),
  output: z.object({ url: shareUrl.nullable() }),
});

const time = z.number().int().nonnegative();
export const activityEntry = z.object({
  id: z.string(),
  type: z.string(),
  date: time,
  target: z.object({ resource, number }).nullable(),
  workspaces: z.array(linked),
});
export const activity = defineRpc({
  name: "cnb.activity",
  input: workspace.extend({ action: z.enum(["status", "sync", "retry"]), repositoryId: z.string().min(1) }),
  output: z.object({
    nextHour: time.nullable(),
    lastSync: time.nullable(),
    error: z.string().nullable(),
    recent: z.array(activityEntry),
    comments: z.object({ pending: time, sent: time, uncertain: time }),
  }),
});

export const autoSync = defineRpc({
  name: "cnb.auto-sync",
  input: z.object({}),
  output: z.object({}),
});

export const issueAction = defineRpc({
  name: "cnb.issue-action",
  input: z.discriminatedUnion("action", [
    workspace.extend({ action: z.literal("link"), number, repositoryId: z.string().min(1) }),
    workspace.extend({ action: z.literal("unlink"), number, repositoryId: z.string().min(1) }),
    workspace.extend({
      action: z.literal("start"),
      requestId,
      number,
      repositoryId: z.string().min(1),
      base: z.string().min(1).max(512),
      provider: z.string().min(1).max(512),
    }),
  ]),
  output: z.object({ workspace: linked, agentId: z.string().optional() }),
});

export const searchIssues = defineRpc({
  name: "cnb.attachment",
  input: z.object({ query: z.string().trim().max(2048) }),
  output: z.object({ items: z.array(z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    url: z.url(),
    text: z.string(),
    resourceType: z.literal("issue"),
  })) }),
});

export const cnbIssues = defineAttachmentSource({
  id: "cnb-issue",
  title: "CNB Issue",
  icon: "CircleDot",
  pickerTitle: "添加 CNB Issue",
  searchPlaceholder: "粘贴完整的 CNB Issue 链接",
  search: searchIssues,
});
