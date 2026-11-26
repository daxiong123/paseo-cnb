import { z } from "zod";
import { activityEntry, number, slug } from "../shared/cnb.ts";
import { parseIssueUrl, type cnb } from "./cnb.ts";

const decimalId = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);
const envelope = z.looseObject({
  id: decimalId,
  type: z.string().min(1),
  repo: z.object({ id: decimalId, path: slug }),
  created_at: z.iso.datetime({ offset: true }).transform((date) => Date.parse(date)),
  payload: z.looseObject({}).optional(),
});
const itemFields = z.object({ number: decimalId.pipe(number), title: z.string(), body: z.string().nullish() });
const commentFields = z.object({ body: z.string() });
const issueEvent = z.object({ issue: itemFields, comment: commentFields.optional() });
const pullEvent = z.object({
  pull_request: itemFields.extend({ head: z.object({ ref: z.string() }).nullish() }),
  comment: commentFields.optional(),
});
const pushEvent = z.object({ ref: z.string(), commits: z.array(z.object({ message: z.string() })) });
const backlink = /^<!-- better-paseo-cnb:[a-f0-9]{64} -->\n/;

export const hour = 60 * 60 * 1000;
export const floorHour = (date: number) => Math.floor(date / hour) * hour;

export function bucketName(epoch: number) {
  const date = new Date(epoch);
  return `${date.toISOString().slice(0, 10)}-${date.getUTCHours()}`;
}

export type Event = z.infer<typeof envelope>;
export type Target = NonNullable<z.infer<typeof activityEntry>["target"]>;
export type IssueRef = { path: string; number: string };
export const refKey = ({ path, number }: IssueRef) => `${path}#${number}`;

export function parseEvents(items: unknown[], repo: { path: string; id: string }) {
  return items.map((item) => {
    const event = envelope.parse(item);
    if (event.repo.path !== repo.path || event.repo.id !== repo.id) {
      throw new Error("CNB 返回了其他仓库的动态");
    }
    return event;
  }).sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
}

export function collectRefs(path: string, texts: string[], branch?: string): IssueRef[] {
  const refs = new Map<string, IssueRef>();
  const add = (ref: IssueRef) => refs.set(refKey(ref), ref);
  for (const text of texts) {
    const local = text.replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => {
      const ref = parseIssueUrl(url.replace(/[.,;:]$/, ""));
      if (ref) add(ref);
      return " ";
    });
    for (const match of local.matchAll(/(?<![\w/#])#([1-9]\d{0,19})(?!\w)/g)) {
      add({ path, number: match[1] });
    }
  }
  if (branch) {
    for (const match of branch.matchAll(/(?:^|[/_-])issue[-_/]([1-9]\d{0,19})(?=$|[/_-])/gi)) {
      add({ path, number: match[1] });
    }
  }
  return [...refs.values()];
}

export async function readActivity(event: Event, client: Pick<ReturnType<typeof cnb>, "item">, repo: {id: string; path: string; webUrl: string}) {
  const payload = event.payload ?? event;
  if (payload.action === "deleted" || payload.action === "dismissed") return null;
  const path = repo.path;

  if (event.type === "PushEvent") {
    const { ref, commits } = pushEvent.parse(payload);
    return { target: null, refs: collectRefs(path, commits.map((commit) => commit.message), ref) };
  }

  if (event.type === "IssueEvent" || event.type === "IssueCommentEvent") {
    const { issue, comment } = issueEvent.parse(payload);
    if (comment && backlink.test(comment.body)) return null;
    if (event.type === "IssueCommentEvent" && !comment) throw new Error("CNB Issue 评论动态缺少评论正文");
    const body = issue.body ?? (event.type === "IssueEvent" ? (await client.item(repo, "issues", issue.number)).body : "");
    const target: Target = { resource: "issues", number: issue.number };
    return { target, refs: [{ path, number: issue.number }, ...collectRefs(path, [issue.title, body, comment?.body ?? ""])] };
  }

  if (["PullRequestEvent", "PullRequestReviewEvent", "PullRequestReviewCommentEvent", "PullRequestCommentEvent"].includes(event.type)) {
    const { pull_request: pull, comment } = pullEvent.parse(payload);
    if (comment && backlink.test(comment.body)) return null;
    if (event.type.endsWith("CommentEvent") && !comment) throw new Error("CNB PR 评论动态缺少评论正文");
    const body = pull.body ?? (await client.item(repo, "pulls", pull.number)).body;
    const target: Target = { resource: "pulls", number: pull.number };
    return { target, refs: collectRefs(path, [pull.title, body, comment?.body ?? ""], pull.head?.ref) };
  }
  return null;
}

export function backlinkBody(key: string, url: string) {
  return `<!-- better-paseo-cnb:${key} -->\n[在 Paseo 中打开工作区](${url})`;
}

export function hasBacklink(body: string, key: string) {
  return body.startsWith(`<!-- better-paseo-cnb:${key} -->\n`);
}
