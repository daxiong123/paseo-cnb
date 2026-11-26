import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { activityEntry, association, automation, shareKey, shareUrl } from "../shared/cnb.ts";
import { CnbHttpError, type cnb, type Repository } from "./cnb.ts";
import { backlinkBody, bucketName, floorHour, hasBacklink, hour, parseEvents, readActivity, refKey } from "./event-format.ts";
import type { Target } from "./event-format.ts";
import type { Workspace } from "./workspaces.ts";
import { issueMetadata, linkedWorkspace } from "./workspaces.ts";

const linkSchema = z.object({
  target: activityEntry.shape.target.unwrap(),
  issue: association,
  workspaceId: z.string(),
  date: z.number(),
  comment: z.enum(["pending", "uncertain", "sent"]).optional(),
  commentSince: z.number().optional(),
  checkedAt: z.number().optional(),
  attemptedAt: z.number().optional(),
  attemptedBy: z.string().optional(),
});
const stateSchema = z.object({
  nextHour: z.number().nullable(),
  lastSync: z.number().nullable(),
  recent: z.array(activityEntry),
  seen: z.record(z.string(), z.array(z.string())),
  links: z.record(z.string(), linkSchema),
  error: z.string().nullable(),
});

type State = z.infer<typeof stateSchema>;
type Automation = z.infer<typeof automation>;
type Cnb = ReturnType<typeof cnb>;
type LinkedWorkspace = { workspace: Workspace; issue: z.infer<typeof association> };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function activityPath(daemonId: string, projectId: string, repositoryId: string) {
  return join(homedir(), "Library", "Application Support", "Better Paseo CNB", `${digest([daemonId, projectId, repositoryId])}.json`);
}

export async function readActivityState(file: string): Promise<State> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { nextHour: null, lastSync: null, recent: [], seen: {}, links: {}, error: null };
    }
    console.error("cnb.activity.state.invalid", { file });
    throw new Error("CNB 动态状态不可读，请查看 daemon 日志。游标已保留");
  }
}

async function save(file: string, state: State) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function activityStatus(state: State) {
  const comments = { pending: 0, uncertain: 0, sent: 0 };
  for (const link of Object.values(state.links)) {
    if (link.comment) comments[link.comment]++;
  }
  return { nextHour: state.nextHour, lastSync: state.lastSync, recent: state.recent, error: state.error, comments };
}

export function workspaceShareUrl(workspace: Workspace) {
  const url = workspace.metadata?.[shareKey];
  return url === undefined ? null : shareUrl.parse(url);
}

function matchesIssue(workspace: Workspace, issue: z.infer<typeof association>) {
  const current = issueMetadata(workspace);
  return !workspace.archivingAt && current?.repositoryId === issue.repositoryId && current.number === issue.number;
}

export async function relatedWorkspaces(state: State, target: Target, refresh: (id: string) => Promise<Workspace | null>) {
  const links = Object.values(state.links).filter((link) => link.target.resource === target.resource && link.target.number === target.number);
  const workspaces = await Promise.all(links.map(async (link) => {
    const workspace = await refresh(link.workspaceId);
    return workspace && matchesIssue(workspace, link.issue) ? linkedWorkspace(workspace) : null;
  }));
  return workspaces.filter((workspace) => workspace !== null);
}

function collectWorkspaces(workspaces: Workspace[], projects: Record<string, Repository>) {
  const byRef = new Map<string, LinkedWorkspace[]>();
  for (const workspace of workspaces) {
    const repository = projects[workspace.projectId];
    if (!repository || workspace.archivingAt) continue;
    const issue = issueMetadata(workspace);
    if (!issue || issue.repositoryId !== repository.id) continue;
    const key = refKey({ path: repository.path, number: issue.number });
    const existing = byRef.get(key) ?? [];
    existing.push({ workspace, issue });
    byRef.set(key, existing);
  }
  return byRef;
}

async function findComment(client: Cnb, repo: Repository, target: Target, key: string, username?: string) {
  for (let page = 1; page <= 30; page++) {
    const comments = await client.comments(repo, target.resource, target.number, page);
    if (comments.some((note) => (!username || note.author.username === username) && hasBacklink(note.body, key))) return true;
    if (comments.length < 100) return false;
  }
  throw new Error("CNB 评论超过核对上限，尚无法确认是否已有回链");
}

export async function synchronizeActivity(args: {
  file: string;
  repo: Repository;
  config: Automation;
  projects(): Promise<Record<string, Repository>>;
  workspaces: Workspace[];
  client(): Promise<Cnb>;
  canPublish(workspaceId: string, url: string, issue: z.infer<typeof association>): Promise<boolean>;
  retry: boolean;
  now?: number;
}) {
  const { file, repo, config, workspaces, retry } = args;
  const now = args.now ?? Date.now();
  const state = await readActivityState(file);
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const currentHour = floorHour(now);
  let activeBucket: string | undefined;
  let activeEvent: string | undefined;
  let posting: string | undefined;

  try {
    const [client, projects] = await Promise.all([args.client(), args.projects()]);
    const index = collectWorkspaces(workspaces, projects);
    const start = Math.max(state.nextHour ?? 0, floorHour(config.since));
    for (let time = start; time <= currentHour && time < start + 2 * hour; time += hour) {
      const bucket = bucketName(time);
      activeBucket = bucket;
      const processed = state.seen[bucket] ??= [];
      const seen = new Set(processed);
      const data = await client.events(repo, bucket);
      for (const event of parseEvents(data, repo)) {
        if (event.created_at < config.since || seen.has(event.id)) continue;
        activeEvent = event.id;
        const activity = await readActivity(event, client, repo);
        if (activity) {
          const matches = new Map<string, LinkedWorkspace>();
          for (const issue of activity.refs) {
            for (const match of index.get(refKey(issue)) ?? []) matches.set(match.workspace.id, match);
          }
          const target = activity.target;
          state.recent.unshift({
            id: event.id, date: event.created_at, type: event.type, target,
            workspaces: [...matches.values()].map((match) => linkedWorkspace(match.workspace)),
          });
          if (target) {
            for (const { workspace, issue } of matches.values()) {
              const key = digest([repo.id, target.resource, target.number, workspace.id]);
              const link = state.links[key] ??= { target, workspaceId: workspace.id, issue, date: event.created_at };
              link.issue = issue;
              if (config.commentsUsername && config.commentsSince && event.created_at >= config.commentsSince && link.comment !== "sent") {
                link.comment ??= "pending";
                link.commentSince = config.commentsSince;
              }
            }
          }
        }
        seen.add(event.id);
        processed.push(event.id);
      }
      state.recent = state.recent.sort((left, right) => right.date - left.date).slice(0, 30);
      // Keep the current and previous hours open so delayed events can still be delivered.
      if (time < currentHour - hour) {
        state.nextHour = time + hour;
        delete state.seen[bucket];
      } else {
        state.nextHour = time === start ? time : state.nextHour;
      }
      await save(file, state);
      console.info("cnb.activity.bucket", { repo: repo.path, bucket, events: data.length, nextHour: state.nextHour });
      activeEvent = undefined;
    }

    state.lastSync = now;
    state.error = null;
    activeBucket = undefined;
    const candidates = config.commentsSince && config.commentsUsername ? Object.entries(state.links).filter(([, link]) =>
      link.commentSince === config.commentsSince && (link.comment === "pending" || link.comment === "uncertain")) : [];
    const deliverable = candidates.flatMap(([key, link]) => {
      const workspace = workspacesById.get(link.workspaceId);
      const url = workspace && projects[workspace.projectId]?.id === link.issue.repositoryId
        && matchesIssue(workspace, link.issue) && workspaceShareUrl(workspace);
      return url ? [{ key, link, url }] : [];
    });
    if (deliverable.length) {
      const { username } = await client.account();
      if (username !== config.commentsUsername) throw new Error("CNB CLI 账号已切换，请关闭并重新开启评论回链以确认当前账号");
      deliverable.sort((a, b) =>
        (a.link.checkedAt ?? a.link.attemptedAt ?? 0) - (b.link.checkedAt ?? b.link.attemptedAt ?? 0));
      const retryTarget = retry ? deliverable.find(({ link }) => link.comment === "uncertain") : undefined;
      const { key, link, url } = retryTarget ?? deliverable[0];
      posting = key;
      link.checkedAt = now;
      const author = link.comment === "uncertain" ? link.attemptedBy : username;
      if (await findComment(client, repo, link.target, key, author)) {
        link.comment = "sent";
      } else if (link.comment === "uncertain" && (!retry || now - (link.attemptedAt ?? now) < 60_000)) {
        throw new Error("上次回链结果待确认。等待至少 1 分钟后，可手动核对并重试");
      } else if (await args.canPublish(link.workspaceId, url, link.issue)) {
        link.comment = "uncertain";
        link.attemptedAt = now;
        link.attemptedBy = username;
        await save(file, state);
        try {
          await client.postComment(repo, link.target.resource, link.target.number, backlinkBody(key, url));
        } catch (error) {
          if (error instanceof CnbHttpError && [400, 401, 403, 404, 422, 429].includes(error.status)) link.comment = "pending";
          throw error;
        }
        link.comment = "sent";
      }
      if (link.comment === "sent") {
        console.info("cnb.activity.backlink.sent", { repo: repo.path, target: link.target, workspaceId: link.workspaceId, posting });
      }
    }
  } catch (error) {
    state.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    console.error("cnb.activity.sync.failed", { repo: repo.path, bucket: activeBucket, eventId: activeEvent, posting, error: state.error });
  }
  await save(file, state);
  return activityStatus(state);
}
