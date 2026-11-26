import { URL } from "node:url";
import { z } from "zod";
import { number, slug, type resource } from "../shared/cnb.ts";
import { entry, pullApi, row } from "./pull-api.ts";

type Resource = z.infer<typeof resource>;
export type Repository = { id: string; path: string; webUrl: string };

export async function resolveManualRepository(saved: Repository, load: (path: string) => Promise<Repository>) {
  const current = await load(saved.path);
  if (current.id !== saved.id) {
    console.warn("cnb.repository.identity-changed", { path: saved.path, expectedId: saved.id, currentId: current.id });
    throw new Error("手动选择的路径已指向其他 CNB 仓库，请恢复从 Git 识别或重新选择仓库");
  }
  return current;
}

const account = z.object({ username: z.string().min(1) });
const repo = z.object({ id: z.string().min(1), path: slug, web_url: z.url() });
const detail = row.extend({ body: z.string().nullish() });
const errorResponse = z.object({ message: z.string().optional(), error: z.string().optional() });
const comment = z.object({ id: z.string(), body: z.string(), author: account });

export class CnbHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Send = <T>(path: string, schema: z.ZodType<T>, options?: {
  body?: string;
  events?: boolean;
  empty?: boolean;
}) => Promise<T>;

function parseEventJson(raw: string): unknown {
  const parse = JSON.parse as (source: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
  return parse(raw, (_key, value, context) => {
    if (typeof value !== "number" || !Number.isInteger(value) || Number.isSafeInteger(value)) return value;
    if (!context?.source || !/^\d+$/.test(context.source)) throw new Error("CNB 动态包含无法精确读取的整数");
    return context.source;
  });
}

export function repoPath(value: string, gitRemote = false): string {
  const url = URL.parse(value);
  if (!url || (!gitRemote && (url.username || url.password)) || url.origin !== "https://cnb.cool" || url.search || url.hash) {
    throw new Error("请输入 cnb.cool 仓库的 HTTPS 链接");
  }
  return slug.parse(url.pathname.slice(1).replace(/\/$/, "").replace(/\.git$/, ""));
}

export function parseIssueUrl(value: string): { path: string; number: string } | null {
  const url = URL.parse(value);
  if (!url || url.origin !== "https://cnb.cool" || url.username || url.password) return null;
  const match = /^\/(.+)\/-\/issues\/([1-9]\d{0,19})\/?$/.exec(url.pathname);
  if (!match || !slug.safeParse(match[1]).success) return null;
  return { path: match[1], number: match[2] };
}

export function issueText(issue: {title: string; url: string; body: string}): string {
  const body = Array.from(issue.body).slice(0, 6000).join("");
  return JSON.stringify({ title: issue.title, url: issue.url, body, truncated: body.length < issue.body.length });
}

export function cnb(token: string, request = fetch) {
  const send: Send = async (path, schema, options) => {
    const start = Date.now();
    let status: number | undefined;
    let requestId: string | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      let response: Response;
      let storage = false;
      try {
        response = await request(`https://api.cnb.cool${path}`, {
          headers: {
            authorization: `Bearer ${token}`, accept: "application/json",
            ...(options?.body ? { "content-type": "application/json" } : {}),
          },
          method: options?.body ? "POST" : "GET",
          body: options?.body,
          redirect: options?.events ? "manual" : "error",
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new Error("CNB 请求超时，请重试");
        }
        throw new Error("连接 CNB 失败，请检查 daemon 的网络后重试");
      }
      status = response.status;
      requestId = response.headers.get("x-request-id")?.replaceAll(token, "[已遮罩]");
      if (options?.events && [301, 302, 303, 307, 308].includes(response.status)) {
        const destination = URL.parse(response.headers.get("location") ?? "");
        if (!destination || destination.protocol !== "https:" || destination.username || destination.password
          || destination.port || !/(^|\.)(cnb\.cool|myqcloud\.com|tencentcos\.cn)$/.test(destination.hostname)) {
          throw new Error("CNB 动态返回了不受支持的存储地址");
        }
        await response.body?.cancel();
        storage = true;
        try {
          response = await request(destination.href, { redirect: "error", signal: controller.signal });
        } catch {
          throw new Error("无法下载 CNB 仓库动态，请检查 daemon 网络后重试");
        }
      }
      status = response.status;
      requestId ??= response.headers.get("x-request-id")?.replaceAll(token, "[已遮罩]");
      const raw = await response.text();
      if (options?.events && (status === 204 || (storage && status === 404 && /<Code>NoSuchKey<\/Code>/.test(raw)))) {
        console.info("cnb.events.empty", { endpoint: path, status });
        return schema.parse([]);
      }
      if (!response.ok) {
        let reason = "";
        if (response.headers.get("content-type")?.includes("json")) {
          try {
            const parsed = errorResponse.safeParse(JSON.parse(raw));
            if (parsed.success) reason = parsed.data.message ?? parsed.data.error ?? "";
          } catch {
            reason = "错误响应不是有效的 JSON";
          }
        }
        const hint = status === 401 ? "CNB 登录已失效或当前接口拒绝访问，请在 daemon 所在机器检查 cnb-cli 登录"
          : status === 403 ? "令牌或 CNB 账号权限不足"
          : status === 404 ? "资源不存在或账号不可访问"
          : "CNB 请求失败";
        const safe = reason.replaceAll(token, "[已遮罩]").slice(0, 400);
        throw new CnbHttpError(status, `${hint}（HTTP ${status}）${safe ? `：${safe}` : ""}${requestId ? ` · ${requestId}` : ""}`);
      }
      let payload: unknown;
      try {
        payload = options?.empty && !raw.trim() ? {} : options?.events ? parseEventJson(raw) : JSON.parse(raw);
      } catch {
        throw new Error("CNB 返回了无效的 JSON");
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        const fields = parsed.error.issues.map((issue) => issue.path.join(".")).slice(0, 5);
        throw new Error(`CNB 响应字段不符合接口契约：${fields.filter(Boolean).join("、") || "响应结构"}`);
      }
      console.info("cnb.request", { endpoint: path.split("?")[0], status, requestId, ms: Date.now() - start });
      return parsed.data;
    } catch (error) {
      console.error("cnb.request.failed", { endpoint: path.split("?")[0], status, requestId, ms: Date.now() - start });
      if (controller.signal.aborted) throw new Error("CNB 请求超时，请重试");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  async function readRepo(path: string) {
    const data = await send(`/${slug.parse(path)}`, repo);
    if (repoPath(data.web_url) !== data.path) throw new Error("CNB 返回的仓库链接与仓库路径不一致");
    return data;
  }

  return {
    ...pullApi(send, token),
    account: () => send("/user", account),
    async repo(path: string): Promise<Repository> {
      const data = await readRepo(path);
      if (data.path !== path) {
        const canonical = await readRepo(data.path);
        if (canonical.id !== data.id || canonical.path !== data.path) {
          console.warn("cnb.repository.alias-mismatch", { requested: path, canonical: data.path, returned: canonical.path });
          throw new Error(`CNB 无法确认两个路径指向同一仓库（${path} → ${data.path}）`);
        }
        console.info("cnb.repository.alias-resolved", { requested: path, canonical: data.path });
      }
      return { id: data.id, path: data.path, webUrl: `https://cnb.cool/${data.path}` };
    },
    async list(repo: Repository, resource: Resource, page: number, keyword: string) {
      const query = new URLSearchParams({ page: String(page), page_size: "20" });
      if (resource === "issues" && keyword) query.set("keyword", keyword);
      const items = await send(`/${repo.path}/-/${resource}?${query}`, z.array(row));
      return { items: items.map((item) => entry(repo, resource, item)), more: items.length === 20 };
    },
    async item(repo: Repository, resource: Resource, id: string) {
      const item = await send(`/${repo.path}/-/${resource}/${number.parse(id)}`, detail);
      if (item.number !== id) throw new Error("CNB 返回了不同编号的资源");
      return { ...entry(repo, resource, item), body: item.body ?? "" };
    },
    events(repo: Repository, bucket: string) {
      if (!/^\d{4}-\d{2}-\d{2}-\d{1,2}$/.test(bucket)) throw new Error("CNB 动态时间区间无效");
      return send(`/events/${slug.parse(repo.path)}/-/${bucket}`, z.array(z.unknown()), { events: true });
    },
    comments(repo: Repository, resource: Resource, id: string, page: number) {
      return send(`/${repo.path}/-/${resource}/${number.parse(id)}/comments?page=${page}&page_size=100`, z.array(comment));
    },
    postComment(repo: Repository, resource: Resource, id: string, body: string) {
      return send(`/${repo.path}/-/${resource}/${number.parse(id)}/comments`, comment, { body: JSON.stringify({ body }) });
    },
  };
}
