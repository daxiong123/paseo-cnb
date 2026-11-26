import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const minimum = [1, 24, 14];
const login = "cnb login --host cnb.cool";

function execute(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string, input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(command, args, { cwd, env, timeout: 15_000, maxBuffer: 65_536 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const operation = args[0];
      console.error("cnb.cli.failed", { operation, code: error.code, signal: error.signal });
      if (error.code === "ENOENT") {
        return reject(new Error(`Paseo daemon 找不到 ${command === "git" ? "Git" : "cnb-cli"}，请检查 daemon 的 PATH`));
      }
      if (error.killed) return reject(new Error(`CNB CLI 操作超时（${operation}）`));
      if (operation === "git-credential" && /未找到有效的登录凭证|请(?:先|重新)执行|Token 已过期/.test(stderr)) {
        return reject(new Error(`CNB CLI 登录不可用，请在 daemon 所在机器执行 \`${login}\``));
      }
      if (operation === "--version" && /node.*(?:No such file|not found)/i.test(stderr)) {
        return reject(new Error("cnb-cli 无法启动，请确认 daemon 的 PATH 包含 Node.js"));
      }
      reject(new Error(`CNB CLI 操作失败（${operation}，退出码 ${String(error.code)}），请检查 daemon 上的 cnb-cli`));
    });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(new Error("无法向 CNB CLI 传递仓库上下文"));
    });
    child.stdin?.end(input);
  });
}

export function cliAuth(environment = process.env) {
  const executable = environment.CNB_CLI_PATH || "cnb";
  let current: Promise<{ token: string; cliVersion: string }> | undefined;

  async function read() {
    if (environment.CNB_CLI_PATH && !isAbsolute(executable)) throw new Error("CNB_CLI_PATH 必须为 cnb-cli 的绝对路径");
    const env: NodeJS.ProcessEnv = {
      ...environment,
      PATH: [environment.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(delimiter),
    };
    // Keep the explicit cnb.cool login selected even on a daemon launched from a CNB task.
    delete env.CNB_TOKEN;
    delete env.CNB_TOKEN_FOR_CODEBUDDY;
    delete env.AGENTOS_RUNTIME_ID;
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    env.GIT_CONFIG_GLOBAL = devNull;
    env.GIT_CONFIG_NOSYSTEM = "1";

    const cliVersion = (await execute(executable, ["--version"], env)).trim();
    const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(cliVersion);
    if (!parsed) throw new Error("无法识别 daemon 上 cnb-cli 的版本号");
    if (parsed.slice(1).map(Number).reduce(
      (comparison, value, index) => comparison || Math.sign(value - minimum[index]), 0,
    ) < 0) {
      throw new Error(`当前 cnb-cli 为 ${cliVersion}。按域名复用 CNB 登录需要 1.24.14 或更新的稳定版本`);
    }

    // Recent cnb-cli helpers verify the requested host against Git remotes.
    const directory = await mkdtemp(join(tmpdir(), "better-paseo-cnb-cli-"));
    try {
      await execute("git", ["init", "--bare", "--quiet", "--template="], env, directory);
      await execute("git", ["config", "remote.origin.url", "https://cnb.cool/"], env, directory);
      const stdout = await execute(executable, ["git-credential", "get"], env, directory, "protocol=https\nhost=cnb.cool\n\n");
      const match = /^password=([!-~]+)$/m.exec(stdout);
      if (!match || !/^username=cnb$/m.test(stdout)) throw new Error("cnb-cli 返回了无效的 Git 凭据");
      return { token: match[1], cliVersion };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return () => current ??= read().finally(() => { current = undefined; });
}
