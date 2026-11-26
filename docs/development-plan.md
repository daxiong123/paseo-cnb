# Better Paseo CNB 开发方案与验收

开发者可以从一个 CNB 开放 Issue 开始，在 Paseo 建立工作区，在实际检出的分支上完成修改，然后把 PR 的检查结果或评审意见带回正在处理它的 Agent。仓库身份来自项目 Git，账号来自 daemon 主机上的 cnb-cli，工作区和 Agent 由 Paseo 管理。本文用于实现变更、定位故障和验收。安装与日常操作请参阅[项目 README](../README.md)。

## 交付范围与顺序

| 阶段 | 使用场景 | 当前交付 |
| --- | --- | --- |
| P0 · Issue 到工作区 | 第一次打开项目，找到开放 Issue，读完正文后开始工作 | CLI 连接检查、Git 仓库发现、手动选择、分页与搜索、Markdown 详情、跨项目待办、关联现有工作区、创建独立 worktree、面板启动 Agent、对话附件。 |
| P0 · 分支到 PR | 完成修改后找到已有 PR，或为刚推送的分支建 PR | 识别实际检出分支、校验远端提交、创建前查重、PR 概览、提交检查、失败构建与阶段日志、反馈草稿。 |
| P1 · 审阅与跟进 | 在同一处阅读变更、提交评审，再回到对应的工作区 | PR 文件差异、逐行与总体评审、同仓库 PR 专用评审 worktree、账号筛选、已关联 Agent 选择。 |
| P1 · 事件关联 | 在 Issue、PR、提交或评论中引用 Issue，回到处理它的 Paseo 工作区 | 按小时拉取仓库动态、跨项目匹配、保存游标与最近事件、按仓库授权评论回链、处理结果未知的发布。 |
| P2 · 协作收尾 | 邀请 CodeBuddy 评审并了解合并阻塞原因 | 用户确认后发布 NPC 请求，面板展示 CNB 的阻塞信息，最终合并由用户在 CNB 原页完成。 |

以上功能都有本地实现。真实仓库的权限、服务端事件延迟、分支保护与团队共享链接，需要按文末清单单独验收。早期方案借鉴了 HiFox 从仓库事件回到协作现场的用法。当前选择由客户端触发 daemon 拉取事件，待取得真实延迟记录后，再决定是否需要 `.cnb.yml` 推送和公网接收端。自动触发 NPC、CI 失败后自动启动修复 Agent 也留待真实工作流验证。[HiFox CNB 集成](https://help.hifox.com/docs/integration/cnb) · [CNB 仓库动态](https://docs.cnb.cool/zh/develops/openapi-event.html)

## 架构与数据归属

Paseo 清单标识是 `better-paseo-cnb`，最低宿主版本为 `0.17.4`。仓库使用同版本的 `@getpaseo/plugin` 编译，客户端使用 React Native 与 TanStack Query，共享边界使用 Zod。[插件清单](../paseo-plugin.json) · [开发依赖](../package.json) · [Paseo 创建插件](https://paseo.sh/zh-CN/docs/plugins#create-a-plugin)

```text
Paseo 客户端    设置「CNB 连接」／侧栏「CNB 待办」／工作区「CNB」／对话附件
                  │ 共享 RPC 契约
Paseo daemon    确认当前账号、项目、仓库与请求对应的资源
                  ├─ cnb-cli 按 cnb.cool 取凭据 → CNB OpenAPI
                  ├─ 项目 Git 根目录识别仓库，实际 worktree 确认分支与提交
                  ├─ Paseo SDK 创建、查找工作区和 Agent，读写工作区元数据
                  └─ 本机状态文件保存动态游标、关联与评论发布结果
```

修改跨进程入参或返回值时，从共享契约找到调用者与处理函数，一并检查客户端的错误状态。下表列出运行时状态的保存位置及再次使用前的身份检查。[客户端入口](../index.client.tsx) · [daemon 入口](../index.server.ts) · [Issue 与动态契约](../shared/cnb.ts) · [PR 与待办契约](../shared/pulls.ts)

| 状态及存放位置 | 识别方式 | 使用与重新核对 |
| --- | --- | --- |
| cnb-cli 账号与凭据 | daemon 主机上的 `cnb.cool` 登录，账号经 `GET /user` 确认 | 设置页只返回账号和 CLI 版本。并发取凭据可共用进行中的请求，完成后再次取用会重读。客户端检测到切换账号或连接检查失败时清理该 host 的业务查询缓存。 |
| 手动选择与自动化开关 | host 级设置 `repositories`，按 Paseo `projectId` 保存 | 项目内所有 worktree 共享仓库选择。手动选择保存远端仓库 ID、路径、网址。自动化另存仓库 ID、启用时间、回链授权账号和时间。 |
| Issue 直接关联 | 工作区元数据 `better-paseo-cnb.issue` | 以仓库 ID 和 Issue 编号识别，记录仓库路径。由插件创建的工作区另记分支和本次创建操作标识，用于恢复。 |
| PR 关联与共享链接 | 工作区元数据 `better-paseo-cnb.pull` 和 `better-paseo-cnb.share-url` | PR 记录所属仓库、编号等信息，评审工作区还记录评审提交。回链使用用户保存、已经验证团队可达的 HTTPS 链接，链接中不得包含账号、查询参数或片段。解除 Issue 关联时同时清除工作区的共享链接。 |
| 动态游标与发布状态 | daemon 用户目录 `~/Library/Application Support/Better Paseo CNB/` 下的 JSON 文件 | 文件名由 daemon、项目、仓库三个 ID 的摘要生成。保存下个小时、已处理事件、最近 30 条动态、关联和发布状态。通过临时文件重命名提交修改。仅在文件不存在时初始化，读取或校验失败时保留原文件并报告错误。 |

### 仓库发现与账号校验

1. 在运行 **daemon 的机器**执行 `cnb login --host cnb.cool`。后端要求能执行 Git 和稳定版 cnb-cli `1.24.14` 或更高版本。若使用 `CNB_CLI_PATH`，值为可执行文件绝对路径。设置页的连接检查验证账号，目标仓库的读取权限在访问该仓库时单独验证。[CLI 适配](../server/cli-auth.ts) · [CNB CLI 文档](https://docs.cnb.cool/zh/develops/cnb-cli.html)
2. daemon 在临时裸 Git 仓库中配置固定的 `https://cnb.cool/` remote，隔离宿主 `GIT_*` 和 CNB 任务令牌环境后，调用 `cnb git-credential get` 获取主机匹配的凭据。实际项目的 Git 检出与远端读取仍使用它原有的 Git 配置。CNB 请求发往 `https://api.cnb.cool`，有 10 秒超时。仓库动态下载跳转不携带原请求的授权头。[API 实现](../server/cnb.ts)
3. 用项目根目录的 `git remote get-url --all` 读取各 remote 的有效地址，因而可以识别经 Git `insteadOf` 展开后指向 CNB HTTPS 的地址。路径支持嵌套组织及 `.git` 后缀。调用仓库详情取得 ID、规范路径和网页链接。旧路径返回其他规范路径时，再读一次规范路径并比对 ID。多个别名指向同一 ID 时视为一个仓库。[Git 发现与工作区](../server/workspaces.ts)
4. 唯一候选可直接使用。存在多个不同仓库时由用户在工作区「CNB」面板选择，无候选时可填写仓库链接。手动选择在读取仓库、Issue 与 PR 列表后保存，后续使用前以 ID 校验。若出现路径被其他仓库占用，提示用户重新选择，或点击「恢复从 Git 识别」。创建 worktree、创建 PR 时还会核对实际 Git 来源。

## 从 Issue 开始工作

侧栏「CNB 待办」按已注册的 Paseo 项目发现仓库，默认列出**全部开放 Issue**，每个仓库每页 20 条。可改为「分配给我的 Issue」「待我评审」「我创建的 PR」。单个项目发现或列表读取失败时显示对应错误，其余仓库仍可浏览。工作区面板支持 Issue 关键词搜索或按编号直达。完整 Issue 链接可粘贴到对话附件入口。PR 标题过滤作用于当前页，精确编号或当前仓库的 PR 链接可以直接打开详情。[待办](../client/pull-inbox.tsx) · [工作区面板](../client/workspace.tsx)

| 入口 | 用户操作 | 预期结果 |
| --- | --- | --- |
| 侧栏待办 → Issue 详情 | 阅读 Markdown，检查已有工作区。若尚未关联，从本地基准分支创建 | 即使项目当前没有打开的工作区，也可从已注册的 Git 项目启动。创建结果是独立工作区，用户可决定何时启动 Agent。 |
| 工作区 CNB → Issue 详情 | 关联当前工作区，或选择基准分支和 provider 启动 | 手动关联保存到当前工作区。选择启动时查找现有关联，必要时创建 worktree，再创建 Agent 并提供 Issue 上下文。已有手动关联可直接打开。 |
| 对话添加附件 → CNB Issue | 粘贴完整的 CNB Issue URL，选择返回项 | 当前对话可附加标题、原页链接和正文摘录。交给 Agent 的 Issue 资料用 JSON 表示，正文最多取 6,000 个 Unicode 码点。 |

**重复点击、超时与解除关联。** daemon 在同一项目内串行处理创建，先分页查找仍有效的关联工作区。匹配出多个有效工作区时报告冲突。新操作用项目 ID、仓库 ID、Issue 编号和本次请求标识派生创建键，重试保留原标识。解除关联后由用户重新发起会产生新标识。worktree 从明确的本地 `refs/heads/<基准分支>` 分出。启动 Agent 前重新读取 SDK 返回的工作区，核对项目、Issue、记录的分支、操作标识及实际检出分支。如果旧请求晚到、工作区已经解除关联或改作他用，daemon 会报告关联或分支已变化。[工作区实现](../server/workspaces.ts)

创建 Agent 失败时工作区与关联继续保留，用户可回到 Issue 重试。已创建的 Agent 通过工作区和操作标签定位。若 Agent 错误退出且初始用户消息未写入，可用同一 Agent 重试首条消息。解除关联只清除 Issue 及其共享链接，现有 Git 工作区与 Agent 仍可从 Paseo 打开。[Paseo Workspaces SDK](https://paseo.sh/docs/sdk/workspaces)

## 从分支到 PR，再把反馈带回 Agent

1. **查找或创建。** 面板从实际 worktree 读取当前分支，用源仓库及分支匹配开放 PR。新建时用户先推送分支，再选择目标分支、标题和正文。daemon 校验项目 Git、当前本地提交与远端分支的 SHA，并检查同一源和目标是否已有开放 PR。创建响应丢失后，重复操作可重新找到已存在的 PR。成功后核对返回的源、目标与仓库，再将 PR 关联写入工作区。[当前分支与创建界面](../client/current-pull.tsx) · [PR 处理](../server/pulls.ts)
2. **检查与反馈。** 概览提供源和目标提交、合并状态、正文和关联工作区。按源提交读取 commit status，同时查询最近一页失败构建。构建读取失败时仍展示已得到的检查结果和构建错误。查看阶段日志时重新核对构建、流水线及阶段。摘录会移除 ANSI 转义和当前访问令牌，保留末尾最多 80 行、6,000 字符。用户预览检查、日志或一条评审意见后，可复制草稿，或将其追加到选定的已关联 Agent 输入框，发送由用户决定。[PR API](../server/pull-api.ts) · [PR 面板](../client/pull.tsx)
3. **查看差异与提交评审。** 文件列表和文件差异绑定打开时的源、目标 SHA。超过 48,000 字符的 patch 在完整行处截断。根据 diff hunk 计算左右侧可评论行。总体意见最多 20,000 字符，可选最多 20 条逐行意见，每条最多 5,000 字符。支持评论、批准及要求修改。切换页签或暂时读取失败时保留输入。源或目标提交变化后，先复核总体意见，再在新版差异中重选行。每次主动提交有独立操作标识，同一次重试按作者和标记核对，允许同一提交在不同时间收到不同的评审决定。[评审界面](../client/pull-review.tsx) · [评审契约](../shared/pulls.ts)
4. **独立评审工作区。** 同仓库 PR 可以把两个明确的提交一起取到本地专用引用，核对 SHA 后，用 Paseo SDK 创建评审 worktree 并设置基准。Fork PR 可以在面板查看差异及评审。评审、NPC、日志草稿都重新读取源和目标提交，发现变化即要求刷新。提交评审前的读取与 CNB 写入是两次网络调用。合并状态、保护规则和最终确认以 CNB 原页为准。[工作区实现](../server/pulls.ts) · [CNB OpenAPI 定义](https://api.cnb.cool/swagger.json)
5. **请求 CodeBuddy。** 用户确认后，用当前 CLI 身份在 PR 中发布含 `@CodeBuddy` 的评论，按作者及源提交标记识别重复请求。返回的反馈可在 PR 中查看。真实 NPC 的可用性、回复和仓库权限要用启用相应服务的测试仓库验证。[CNB NPC](https://docs.cnb.cool/zh/build/npc.html)

## 仓库动态与评论回链

**何时采集。** 用户按仓库启用动态。连接中的 Paseo 客户端在加载时与之后每分钟触发同步，daemon 过滤间隔不足 55 秒的自动触发，对同一仓库串行处理。首次从开启时间读取 UTC 小时分片，单次最多处理两个分片。当前小时和上一小时保持开放，便于接收迟到事件。客户端离线时暂停触发，重新连接后从保存的游标继续。事件 ID 以原始十进制精度保存。处理前比对事件内的仓库 ID 和路径。[客户端触发](../index.client.tsx) · [动态处理](../server/activity.ts)

**怎样关联。** Issue 与 PR 的标题、正文、评论，Push 的提交信息和分支名均可提供线索。同仓库文本用 `#42`，分支可用 `issue-42`。跨仓库要使用完整 CNB Issue URL。先匹配各项目已确认仓库内的 Issue 工作区，再记录目标 Issue 或 PR 和工作区的关系。Push 记录事件与匹配结果，没有可写评论的目标。已删除、已撤销的动态和插件自己的回链评论被跳过。某事件解析或补读失败时，保留错误和已处理进度，下次补拉可继续核对。[事件与引用解析](../server/event-format.ts)

**怎样发回链。** 用户要先验证团队能打开工作区 HTTPS 链接并保存，再在目标仓库单独启用评论回链，确认发布账号。只处理授权时间起的新事件。发布前重新核对设置、当前 CLI 账号、项目仓库、Issue 关联及共享链接。切换账号后，面板提示重新确认授权。回链以目标仓库、资源类型、编号和工作区 ID 去重，各状态的含义如下。[动态面板](../client/activity.tsx)

| 发布状态 | 进入条件 | 下次处理 |
| --- | --- | --- |
| `pending` | 事件产生了待写回的关联，或远端明确拒绝写入 | 符合条件时查找已有标记，再尝试写入。每次处理一个可发布目标，轮换最近尝试过的目标。 |
| `uncertain` | 发起远端写入前已落盘，尚未确认远端结果 | 先在目标评论中查作者与隐藏标记。查到后确认为已发。未查到且结果仍未知时，等待至少一分钟，由用户「核对并重试」。超过核对页数上限时显示原因。 |
| `sent` | CNB 明确返回成功，或在目标评论中找到对应回链 | 后续相同事件与关联复用已记录的发布结果。 |

## RPC 按用户入口索引

| 入口 | 契约 | 使用时应核对 |
| --- | --- | --- |
| 设置与工作区上下文 | `cnb.cli-connection`、`cnb.workspace`、`cnb.repository` | 连接返回 CLI 版本、账号。上下文含项目、仓库、实际分支和关联。手动候选先在 daemon 校验，再由客户端保存。 |
| 工作区 Issue 与对话附件 | `cnb.list`、`cnb.item`、`cnb.issue-action`、`cnb.attachment` | 列表支持 Issue 和 PR。单项详情供 Issue 使用。关联、解除、启动对应不同输入。附件需要完整 Issue URL。 |
| 跨项目待办 | `cnb.inbox`、`cnb.inbox-issue`、`cnb.issue-workspace` | 列表按仓库返回结果与错误。启动入口校验项目、仓库、Issue 状态、本地基准和本次请求标识。 |
| 工作区动态 | `cnb.share-url`、`cnb.activity`、`cnb.auto-sync` | 共享链接属于关联工作区。动态入口区分状态、手动同步和核对重试。自动轮询在 daemon 汇总启用的仓库。 |
| 分支与 PR 概览 | `cnb.current-pull`、`cnb.create-pull`、`cnb.pull-overview` | 从实际分支发现、从远端已推送提交创建、用规范仓库和编号读 PR 详情。 |
| CI 与反馈 | `cnb.pull-checks`、`cnb.pull-stages`、`cnb.pull-feedback`、`cnb.pull-draft` | 传递源、目标 SHA。阶段从所选构建读取。草稿按所选检查、阶段或反馈生成。 |
| 差异、评审与 NPC | `cnb.pull-files`、`cnb.pull-file`、`cnb.pull-review`、`cnb.pull-worktree`、`cnb.pull-npc` | 文件和评审针对当前快照。总体意见、行号、操作标识有独立校验。专用工作区限制为同仓库 PR。 |

## 验收方法

本地确定性测试、Paseo daemon 加载与交互、真实 CNB 操作应分别记录结果。记录时写明代码提交、Paseo 版本、cnb-cli 版本、仓库类型及可复查的结果。Robin 的项目分别记录了宿主安装、可重复运行的测试和真实服务验证，本项目沿用这种区分证据的方式。[Robin 的 README](https://github.com/robbin/paseo-antigravity/blob/510340d304e4f5894fd793fbe79504944487b544/README.md) · [Robin 的验收记录](https://github.com/robbin/paseo-antigravity/blob/510340d304e4f5894fd793fbe79504944487b544/VALIDATION.md)

### 1. 本地与模拟

在项目根目录按锁文件安装依赖，然后运行类型检查和测试套件。

```sh
npm ci
npm run typecheck
npm test
```

| 测试入口 | 核心验收场景 |
| --- | --- |
| [CLI 适配](../tests/cli-auth.test.ts) 与 [账号缓存](../tests/client-cache.test.ts) | 固定主机取凭据、并发读取、拒绝过旧版本。账号变化时清除旧账号的业务数据。 |
| [CNB 请求、Git 与 Issue](../tests/cnb.test.ts) | 路径解析、仓库别名与 ID 核对、分支选择、工作区创建、重试与 Agent 上下文。 |
| [PR](../tests/pulls.test.ts) | 当前分支识别、创建与重复提交、提交变化、CI 与差异、评审与 NPC 标记、评审 worktree 和待办。 |
| [动态](../tests/activity.test.ts) | 超出 JavaScript 安全整数的事件 ID、跨仓库同号、处理一半失败后恢复、账号切换和评论重复发布。 |

### 2. 宿主加载及人工走查

首次从源码安装时运行 `paseo plugin install "$PWD"`。对已安装的开发副本，使用以下命令重载插件，检查其状态并读取后端日志。

```sh
paseo plugin reload better-paseo-cnb
paseo plugin ls better-paseo-cnb
paseo plugin logs better-paseo-cnb
```

从设置页确认可见 CLI 状态和具体的错误，再分别打开「CNB 待办」、工作区「CNB」和对话「CNB Issue」附件入口。选取含标题、列表和代码块的 Issue 检查详情。在待办创建工作区，在面板重开同一条 Issue 核对复用，并验证一次可恢复错误。记录所用宿主、账号是否为模拟身份以及操作实际到达哪一步。仅看到插件处于 `running` 能证明加载成功。操作结果需各自核对。

### 3. 指定真实测试仓库后执行

| 路径 | 操作 | 通过依据 |
| --- | --- | --- |
| 账号与仓库 | 使用 daemon 上受测账号登录，分别访问允许读取的公开与私有仓库，在同一项目的第二个 worktree 打开面板 | 身份与 CLI 相同，仓库规范路径、ID 和分支正确。无权限项目显示明确错误，其余项目可用。 |
| Issue → 工作区 → Agent | 在「全部开放 Issue」选择未分配给自己的 Issue，核对 Markdown，创建工作区，返回后再次打开。在面板选择 provider 启动 | 与 CNB 原页相符，实际分支基于选定的本地分支，选中的 Issue 和工作区唯一对应，Agent 收到正确资料。 |
| PR 与 CI | 推送测试分支，创建 PR，打开检查、失败构建和阶段日志，预览一条草稿并追加到已有 Agent | CNB 原页只有预期的 PR，检查和构建属于选定提交，Agent 输入框可编辑，未确认发送前没有新任务。 |
| 审阅与保护规则 | 在允许写入的测试 PR 提交总体及逐行意见。更新分支后尝试提交旧草稿。经确认请求 CodeBuddy | CNB 原页的意见、行和版本正确，旧版本有明确提醒。记录 NPC 回复和实际合并阻塞原因。 |
| 动态与团队链接 | 先用另一名获授权成员打开待发布的链接，再启用回链。通过 Issue、PR 或评论产生引用，记录事件时间、首次发现时间、回链和重连补拉 | 匹配正确工作区，每个目标与工作区仅有一条回链，团队成员从 CNB 评论可打开工作区，结果与本地发布状态一致。 |

上述第三层仍待用户指定测试仓库。故障记录附上仓库规范路径、Issue 或 PR 编号、工作区 ID、提交 SHA，以及日志中的请求标识和时间。仓库重命名先查 `cnb.repository.alias-resolved` 或 `cnb.repository.identity-changed`，上游错误查 `cnb.request.failed`，评审过期查 `cnb.pull.revision.changed`，动态中断查 `cnb.activity.sync.failed`。日志和验收记录应排除凭据、原始 remote、Issue 正文、Agent 提示及完整构建日志。
