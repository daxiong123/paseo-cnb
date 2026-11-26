# Better Paseo CNB 维护指南

本仓库是运行在 Paseo 客户端和 daemon 上的 CNB 插件，插件 ID 为 `better-paseo-cnb`，显示名为 **Better Paseo CNB**。维护时先明确操作会改变什么对象：浏览待办是查询，创建 worktree 会改变本机 Git 与 Paseo 状态，提交评审和自动回链则会写入 CNB。安装与使用见 [README](README.md)，功能范围、接口分工与阶段验收见[开发方案](docs/development-plan.md)。

## 工作约定

1. **让失败可见。** 在最接近故障的位置保留可用于诊断的错误，在调用入口给出用户可以采取的下一步。仓库无权限、登录失效、分页失败和真正的空结果需要分别处理。跨仓库待办允许其他仓库继续展示，失败项要标出对应的项目或仓库。
2. **修复根因。** 修改前查清入口、RPC、daemon、上游数据和测试之间的调用路径。先将故障缩小到可复现的条件，再改负责该行为的代码。需要补证据时，说明已观察到的现象、缺少什么信息及下一处可观测点。
3. **保留可观测性。** 让启动、成功、失配、失败及待核对结果能够区分。网络失败应能区分认证、权限、网络、上游契约异常；工作区操作应能区分创建失败、关联变化及 Agent 启动失败。
4. **贯穿关键标识。** 涉及写入或重试时，保留能把前一次操作和这次结果对应起来的标识。优先记录操作 ID、项目或工作区 ID、CNB 资源编号、已规范化路径、HTTP 状态和上游请求标识。排查所需的字段与脱敏要求见下文。
5. **让文档随实现更新。** 改动宿主版本、认证、数据归属、幂等或写入边界时同步更新本文件。用户操作变化更新 README 和插件介绍，技术决策与验收变化更新开发方案。版本和依赖的确切值以插件清单、包清单和锁文件为准。参见 [插件清单](paseo-plugin.json)、[包清单](package.json)、[插件介绍](OVERVIEW.md)。
6. **保护主干。** 大规模重构和实验性修改前先切到独立分支。开始时检查当前分支及工作区已有改动；联调使用明确的测试项目、工作区和远端仓库，避免影响他人的分支和评审。

## 修改从哪里开始

| 想改的行为 | 先检查的代码 | 维护要点 |
| --- | --- | --- |
| Paseo 菜单、面板、附件与轮询 | [客户端入口](index.client.tsx) | 注册设置页、工作区面板、侧栏待办与 Issue 附件。客户端发起轮询，插件卸载时清理定时器。 |
| 页面状态、正文显示、草稿 | [待办](client/pull-inbox.tsx)、[工作区](client/workspace.tsx)、[评审](client/pull-review.tsx) | React Native 组件通过 TanStack Query 调用 RPC。两个 Issue 详情入口都用 Paseo 的 Markdown 组件；修改正文展示时验证两处及空正文。 |
| 账号、缓存与手动配对 | [设置页](client/settings.tsx)、[账号缓存](client/connection-cache.ts)、[daemon 入口](index.server.ts) | 缓存按 host 隔离。账号变化或连接检查失败时清理该 host 的业务缓存，拒绝访问后隐藏此前查询到的私有内容。 |
| 跨进程输入和输出 | [Issue 与活动契约](shared/cnb.ts)、[PR 契约](shared/pulls.ts) | 使用 Zod 描述前后端共同依赖的数据形状。改契约时一起检查 RPC 注册、调用方和模拟响应。Issue 编号及上游大整数标识保留原始精度。 |
| CLI、OpenAPI 与 Git | [CLI 鉴权](server/cli-auth.ts)、[CNB 请求](server/cnb.ts)、[Git 和工作区](server/workspaces.ts) | 让 daemon 完成凭据读取、网络和本地 Git 操作。客户端只接收本次操作所需的数据。 |
| PR、CI 和仓库动态 | [PR 操作](server/pulls.ts)、[PR 接口适配](server/pull-api.ts)、[事件解析](server/event-format.ts)、[同步与持久化](server/activity.ts) | 接口适配处理 CNB 的字段与分页，daemon 操作层核对目标、版本和当前状态。 |

## 身份与状态

- **CLI 账号**属于运行 daemon 的系统用户。插件要求支持按主机取凭据的稳定版 cnb-cli 1.24.14 或更高版本，可通过 daemon 的 `CNB_CLI_PATH` 指定绝对路径。适配器在隔离的临时 Git 环境中请求 `cnb.cool` 的凭据，用于 daemon 的 OpenAPI 调用。真实项目的 fetch 和 push 沿用项目的 Git 认证。排查时分别验证 CLI 账号和 Git 访问。
- **仓库身份**由 CNB 仓库 ID 确定。自动发现从项目根目录枚举 Git remote，再让 Git 解析实际 URL，支持 `insteadOf`。候选来自解析后的 CNB HTTPS 地址，多个 remote 指向同一仓库时按 ID 合并；多个不同仓库需选择。手动配对按 `projectId` 保存在 host 设置中，每次使用前核对当前仓库 ID；恢复 Git 识别会移除该项目的手动记录。
- **工作区关联**保存在 Paseo 元数据中。Issue 对应 `better-paseo-cnb.issue`，PR 对应 `better-paseo-cnb.pull`，经确认的工作区链接对应 `better-paseo-cnb.share-url`。同一项目可有多个 worktree，读取当前分支及执行分支校验时应使用实际工作区目录。调整元数据结构须覆盖旧记录缺少可选字段的情形。
- **仓库动态**另存于 daemon 用户目录。状态文件按 daemon、项目与仓库 ID 的组合区分，包含 UTC 小时游标、事件去重信息、最近动态、工作区关联和评论状态。写入使用临时文件再替换。遇到损坏文件时保留现场并报告错误，避免从零补拉而重复发布评论。

## 写入、重试与草稿

### 从 Issue 创建工作区和 Agent

待办的「新建工作区」只建立或打开工作区。工作区面板可选择基准分支和 Agent 模型后启动 Agent。两条路径都要核对实际仓库、所选本地分支和当前关联；同项目同一 Issue 出现重复工作区关联时，应显示错误以便修正。

首次创建意图与该次操作的网络重试共用请求标识。解绑后主动重新创建属于新意图。宿主返回工作区后再次读取元数据；往其中启动 Agent 或重发首条提示前，核对实际检出分支。工作区创建和 Agent 启动使用各自的幂等键。Agent 启动失败时保留已创建的工作区，并核对现有 Agent 的标签、身份和首条消息状态。Issue 正文在提示中作为有长度上限的外部资料传入。

### PR 和评审

- 创建 PR 以实际 worktree 的当前分支为源。优先查找同仓库、同源分支和同目标分支的开放 PR；准备新建时核对本地与远端源分支的提交，由用户先完成推送。
- 评审提交属于一次具体的用户操作。响应丢失后的重试携带原请求 ID，daemon 通过 CNB 已有记录中的操作标记核对结果。用户先批准、再请求修改、最后再次批准，是三次独立操作。
- 版本发生变化时保留未提交的评审文字，并要求复核旧版本的行内位置。评审 worktree 固定源、目标提交，同仓库 PR 由 SDK 创建，Fork PR 在面板评审。最终合并由用户打开 CNB 原页完成。
- 失败检查、构建阶段日志及评审反馈可以生成草稿。用户预览、选定 Agent 后追加到其输入框；保留这一步，让用户决定实际发送的内容。

### 自动回链

连接中的客户端每分钟触发同步，daemon 对重复触发节流。按仓库开启同步与评论授权，在工作区保存经团队确认可访问的 HTTPS 链接。发送前重新核对目标仓库、授权账号、工作区与 Issue 的关联及链接。关联仓库解析失败时保留游标，使恢复后的事件仍有机会建立关联。

发布状态有 `pending`、`uncertain` 和 `sent`。结果不明时按评论作者及操作标记查 CNB，查到已有评论即可确认。未查到且距上次发送尝试至少一分钟时，允许手动「核对并重试」。维护队列时，分别模拟某个目标始终查不到评论和持续返回 403。两种情况下，同仓库其他待确认回链都应有机会核对。排查失败项时，按日志中的仓库和发布标识定位。

## 日志与排查

在运行目标插件的 daemon 上执行 `paseo plugin logs better-paseo-cnb`。从一次用户操作的时间开始，结合以下事件查看失败发生在哪一步。

| 现象 | 日志或现场 | 下一步 |
| --- | --- | --- |
| 终端可登录，面板连接失败 | `cnb.cli.failed`、`cnb.request.failed` | 检查 daemon 系统用户、可执行文件路径、CLI 版本、HTTP 状态及请求标识。 |
| 仓库发现失败或路径被复用 | `cnb.workspace.discovery.failed`、`cnb.repository.identity-changed`、`cnb.repository.alias-mismatch` | 比较 Git 展开后的主机和仓库路径、保存的仓库 ID 与 CNB 返回的 ID。 |
| 工作区已建，Agent 未启动 | `cnb.issue.workspace-ready`、`cnb.issue.workspace-mismatch`、`cnb.issue.branch-changed`、`cnb.issue.start.failed` | 结合操作 ID 检查 workspace 元数据、当前分支和已关联 Agent，再决定重试动作。 |
| 评审版本过期或动态未推进 | `cnb.pull.revision.changed`、`cnb.activity.sync.failed`、`cnb.activity.state.invalid` | 比较源与目标提交，或按小时分片、事件 ID、上次游标和发布状态定位失败。 |

日志使用明确选择的字段。不要输出凭据、Authorization 请求头、原始 Git remote、预签名下载地址、CLI 原始输出、Issue 正文、逐行评审或完整阶段日志。排查下载重定向时检查目标主机和 HTTP 状态；CNB 的 bearer 凭据仅随原 API 请求发送。复现资料用合成数据替代团队私有内容。

## 开发与交付验证

本地开发使用 Node.js 22.18 或更高版本；包清单固定 Paseo 插件 SDK 为 0.17.4。首次检出，或锁文件发生变化时，先从仓库根目录安装依赖，再运行项目脚本。

```sh
npm ci
npm run typecheck
npm test
```

测试采用 Node 的测试运行器。需要单独重现时，可执行 `node --test tests/cnb.test.ts`，其余文件按同样方式运行。

| 测试文件 | 适合验证的行为 |
| --- | --- |
| [cli-auth.test.ts](tests/cli-auth.test.ts) | 合成 CLI、主机隔离、并发取凭据与旧版本拒绝。 |
| [cnb.test.ts](tests/cnb.test.ts) | 仓库路径与 ID、API 分页、临时 Git 仓库、工作区创建与 Agent 重试。 |
| [pulls.test.ts](tests/pulls.test.ts) | 临时 Git 传输、PR 创建与复用、失败检查和反馈草稿、行内评审、重复请求和待办归并。 |
| [activity.test.ts](tests/activity.test.ts) | 合成事件、下载重定向、整数精度、游标重放、跨仓库关联、回链发布和部分失败。 |
| [client-cache.test.ts](tests/client-cache.test.ts) | 同一 host 切换或退出账号后的缓存清理，以及用户请求 ID 的契约。 |

首次从当前检出安装，执行 `paseo plugin install "$PWD"`。修改已安装的本地插件后按以下顺序核对实际装载状态。

```sh
paseo plugin reload better-paseo-cnb
paseo plugin ls better-paseo-cnb
paseo plugin logs better-paseo-cnb
```

先核对状态为 `running`，安装来源指向当前检出。再走与本次改动相关的正常入口和一种错误路径。例如，修改 Issue 创建时，从待办进入详情并创建，随后切换测试 worktree 的分支，验证 Agent 启动会给出明确的分支提示。修改缓存时，在模拟环境验证成功、换账号和拒绝访问三个结果。远端评审、自动评论和团队回链可达性使用获得授权的测试仓库单独验证。

交付记录应说明使用的宿主版本、执行的命令、实际重载结果、验证过的入口及待验证项目。区分合成 CLI/HTTP 测试、隔离 daemon 的 SDK 测试和真实 CNB 写入。Robin 的 Better Paseo Antigravity 将运行时要求、诊断方式和验证记录分别写明，这种组织方式也适用于这里。参见 [Robin 项目的 README](https://github.com/robbin/paseo-antigravity/blob/510340d304e4f5894fd793fbe79504944487b544/README.md) 与[验证记录](https://github.com/robbin/paseo-antigravity/blob/510340d304e4f5894fd793fbe79504944487b544/VALIDATION.md)。
