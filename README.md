# Better Paseo CNB

在 Paseo 侧栏打开 **CNB 待办**，选择一个开放 Issue，阅读 Markdown 正文，再用本地基准分支创建工作区。开发完成后，可以在同一工作区为已推送的分支创建 CNB Pull Request（PR）、评审差异，并把失败检查或评审意见带回 Agent 对话。

插件 ID 为 `better-paseo-cnb`。它使用 **Paseo daemon 所在机器上 cnb-cli 的登录账号**访问 cnb.cool。手机或浏览器连接远程 Paseo 时，Git 检出、CLI 安装和登录都在远程 daemon 那台机器上完成。

## 安装前准备

| 准备项 | 用途 | 如何确认 |
| --- | --- | --- |
| Paseo 0.17.4 或更高版本 | 提供插件、工作区和 Agent SDK | 在 daemon 上运行 `paseo --version`，并在 Paseo 设置的「插件」页启用插件 |
| cnb-cli 稳定版 1.24.14 或更高版本 | 让插件按主机取得 cnb.cool 登录凭据 | 用运行 daemon 的系统用户执行 `cnb --version` 和 `cnb login --host cnb.cool` |
| Git 与本地项目 | 识别仓库、列出基准分支、创建 worktree、核对远端提交 | 将已检出的项目添加到 Paseo；项目中至少要有一个有提交的本地分支才能从 Issue 建工作区 |
| Paseo 中可用的 Agent 模型 | 从 Issue 直接启动对话 | 在「从 Issue 开工」中查看模型列表。只浏览 Issue 或创建工作区时可以稍后再选模型 |
| Node.js 22.18 或更高版本及 npm | 从源码安装开发依赖、运行类型检查和测试 | 在源码检出目录运行 `node --version` 和 `npm --version` |

CNB 的 API 权限与 Git 拉取、推送权限分别生效。能够读取 Issue 的账号也可能没有构建日志或 PR 评审权限。可先验证只读浏览，再按实际使用的操作配置权限。 [CNB CLI 鉴权](https://docs.cnb.cool/zh/develops/cnb-cli.html#鉴权) · [CNB Git 访问](https://docs.cnb.cool/zh/guide/git-access.html)

## 安装与更新

**从 Git 安装。** 在 Paseo 的插件设置页，将本仓库的 GitHub 地址填入插件来源并安装。通过命令行安装和查看状态也可完成同一操作。

```sh
paseo plugin install git:daxiong123/paseo-cnb
paseo plugin ls better-paseo-cnb
```

插件来源分支需要已包含 `paseo-plugin.json`。要试用尚在评审的版本，可以在安装命令末尾加 `--ref 分支名`。从 Git 安装后，用 `paseo plugin update better-paseo-cnb` 检查和应用更新。 [Paseo 插件安装说明](https://paseo.sh/docs/plugins)

**从本地源码运行。** 在包含插件清单的仓库根目录执行以下命令。Paseo 会从这个目录加载插件，修改代码后可单独重载。

```sh
npm ci
npm run typecheck
npm test
paseo plugin install "$PWD"
paseo plugin reload better-paseo-cnb
paseo plugin ls better-paseo-cnb
```

看到状态 `running` 后，打开 **设置 → 插件 → Better Paseo CNB → CNB 连接 → 检查连接**。页面会显示 CNB 用户名及 CLI 版本。daemon 环境找不到所需 CLI 时，可用 `CNB_CLI_PATH` 指向可执行文件的绝对路径。插件设置仅保存项目选择与同步授权，登录凭据由 CLI 管理。

## 从第一个开放 Issue 创建工作区

1. 在 Paseo 中添加一个本地 Git 项目，确保项目的有效远端指向 cnb.cool。打开侧栏 **CNB 待办**，默认筛选为 **全部开放 Issue**。列表按仓库分组，可翻页读取。「分配给我的 Issue」是单独的筛选项。
2. 在某条 Issue 上点 **查看详情**。详情显示编号、状态、标题和 Markdown 正文。需要查看完整的 CNB 网页上下文时，点 **在 CNB 打开**。
3. 选择**基准分支**并点 **新建工作区**。Paseo 从选中的本地分支建立独立 Git worktree，并打开它。同一项目里已经关联该 Issue 时，按钮会变成 **打开关联工作区**。
4. 要让 Agent 开工，在新工作区打开 **CNB** 面板，进入该工作区关联的 Issue，点 **从 Issue 开工**，选择 Agent 模型并确认启动。Agent 会收到 Issue 标题、链接和有长度限制的正文。也可以直接从已有工作区的 CNB 面板进入一条尚未关联的 Issue，一步完成建 worktree 和启动 Agent。
5. 如果代码本来就在合适的工作区，使用 **关联到当前工作区** 即可。手动关联的 Issue 可直接打开该工作区继续开发。只想给已有对话补充背景，可以通过 **CNB Issue** 附件入口粘贴完整的 Issue 网页链接。

创建操作重试时会查找已有工作区和 Agent。Agent 启动失败时工作区会保留。用户若在 Issue worktree 中切换到另一任务分支，启动入口会提示切回关联分支；若工作已改为处理别的 Issue，可先解除旧关联，再为新的 Issue 选择工作区。

## 仓库是怎样识别的

插件从 **Paseo 已登记的项目**寻找仓库。它读取 Git 实际使用的 fetch URL，支持 `insteadOf` 展开后的 cnb.cool HTTPS 地址、嵌套组织路径和 `.git` 后缀。当前工作区的分支从当前 worktree 读取，所以同项目的两个工作区可以显示不同的分支与 PR。

| 工作区显示 | 原因与操作 |
| --- | --- |
| 从 Git 识别 | 有效远端对应一个 CNB 仓库。多个 remote 或旧地址经过 CNB 核对后指向相同仓库 ID，也会归为一个仓库 |
| 发现多个 CNB 仓库 | 在工作区 CNB 面板选择本项目对应的仓库。同项目的其他 worktree 共享这项选择 |
| 未发现 CNB 仓库 | 检查项目的 fetch URL，或者在面板填写完整 HTTPS 仓库链接。手动选择可以用于浏览；创建 Issue worktree 时还会核对本地项目 remote |
| 手动选择的路径已指向其他仓库 | 插件核对发现仓库 ID 已变更。确认目标后重新选择，或点 **恢复从 Git 识别** 清除项目覆盖 |

修改 remote 后，在工作区点 **重新读取**，在待办页点 **刷新**。如需本机核实 Git 的解析结果，可运行 `git remote`，再对相应名称运行 `git remote get-url --all <名称>`。某些 remote 可能含凭据，分享诊断信息时仅提供主机和仓库路径。

## PR、评审和失败检查

| 目标 | Paseo 中的操作 | 结果 |
| --- | --- | --- |
| 给当前分支建 PR | 先在 Git 面板推送分支，再在 CNB 面板的「当前分支」选 **新建 PR**，核对目标分支、标题和描述 | 插件核对远端提交，复用已有的同源同目标开放 PR，或在 CNB 创建 PR。有关联 Issue 时会预填引用 |
| 定位某条 PR | 在工作区切到 PR，可按编号、当前仓库 PR 链接或当前页标题查找。在待办也可筛选 **待我评审** 和 **我创建的 PR** | 在有工作区的项目里可看正文、版本、关联工作区及检查。待办中尚无工作区的 PR 提供 CNB 原页入口 |
| 提交评审 | 在 **文件与评审** 选文件和差异行，将逐行意见加入评审，再选评论、批准或请求修改 | 切换页签会保留已写的评审文字。源或目标提交变化后，旧版本的逐行意见需要重新选行，总结和结论也需复核 |
| 本地检出评审版本 | 在同仓库 PR 的 **操作** 中创建或复用独立评审工作区 | 复用前检查工作区仍关联此 PR，实际检出的分支与提交仍对应评审版本。如果你已切换分支或添加提交，插件会提示检查并保留现场。Fork PR 可在面板内评审 |
| 处理 CI 失败 | 从 **检查** 选择失败检查，或进入失败构建选择具体阶段，准备修复草稿 | 草稿带上 PR、提交和相关检查信息。阶段日志截取末尾最多 80 行、6,000 字符，便于复核后交给 Agent |
| 跟进评审反馈 | 在 **反馈** 选择一条有正文的意见，准备 Agent 草稿 | 可以编辑、复制或追加到所选 Agent 的输入框；由用户在对话中发送 |
| 请求 CodeBuddy 或完成合并 | 在 **操作** 中确认请求 CodeBuddy；需要合并时点 **在 CNB 打开** | CodeBuddy 请求会在 PR 发布评论。最终合并在 CNB 原页完成，便于核对版本、权限及仓库的分支保护规则 |

工作区 Issue 搜索使用 CNB 的关键字查询；PR 标题过滤仅作用于当前加载页。大仓库中已知编号时，直接按编号打开通常更快。 [CNB OpenAPI](https://docs.cnb.cool/zh/develops/openapi.html)

## 仓库动态与评论回链

在工作区 **CNB → 仓库动态 → 查看动态与回链设置** 中开启 **自动同步**。Paseo 客户端连接时约每分钟触发一次同步，daemon 按 UTC 小时读取 CNB 事件并保存处理进度。客户端重新连接后会补拉进度。面板可看最近事件、上次同步时间、游标与回链状态，也可以点 **立即同步**。

同仓库的 `#42`、分支名中的 `issue-42`，或正文中的完整 CNB Issue 链接，都可以用于关联已有工作区。跨仓库引用请使用完整链接。一次事件涉及的仓库暂时无法解析时，daemon 保留进度供重试。 [CNB 仓库动态](https://docs.cnb.cool/zh/develops/openapi-event.html)

**自动评论回链是单独的授权。** 先在已关联 Issue 的工作区填写团队成员可以访问的 HTTPS 链接，核对可达性并保存。随后在允许发布评论的目标仓库开启 **自动评论回链**。插件使用当时确认的 CNB 账号向有关 Issue 或 PR 发布链接。更换 CLI 账号后，需要关闭并重新开启回链以确认发布身份。

面板将回链区分为待发送、待确认和已发送。若发出请求后网络中断，插件会按账号、目标和操作标记查找已有评论。多条回链同时待确认时会依次核对，即使其中一条一直查不到，其他已发布的回链也能得到确认。如果仍使用发出请求时的授权，上次发送尝试至少一分钟后可点 **核对并重试**。重新开启回链或更换账号后，插件仍会按原发布账号查找旧评论，旧授权下的回链只做核对。

## 常见问题

| 现象 | 建议先检查 |
| --- | --- |
| 插件已运行，但连接检查找不到 CLI 或提示版本太旧 | 在 daemon 机器上用同一系统用户检查 `cnb --version`、可执行文件路径和 `CNB_CLI_PATH` |
| 待办没有预期的 Issue | 检查筛选是否为「全部开放 Issue」、账号是否有权限、列表是否还有下一页。确认仓库对应的本地项目已添加到当前 daemon |
| 能看详情，却没有可选的基准分支 | 确认是本地 Git 项目且已有分支，项目 remote 与选定 CNB 仓库一致。已有 Issue 关联时可直接打开已有工作区 |
| 提示先推送分支 | 将当前 worktree 分支的最新提交推送到选定的 CNB 仓库，再回到面板创建 PR |
| PR 检查可读，构建日志提示 403 | 提交检查与构建日志调用不同接口。检查当前账号对该仓库的构建读取权限 |
| 找不到关联 Agent | 在源分支工作区打开 PR 并确认已有 Agent；也可以先复制草稿，再放入需要的对话 |
| 需要报告错误 | 运行 `paseo plugin logs better-paseo-cnb`，附操作时间、插件入口、HTTP 状态及请求标识。保留报错原文中的操作标识，移除个人工作区链接和凭据 |

## 开发与验收

`index.client.tsx` 注册设置、工作区面板、待办和附件入口。`index.server.ts` 注册 daemon 端 RPC。界面在 `client/`，跨端契约在 `shared/`，Git、鉴权、CNB API 与同步实现在 `server/`。本地测试位于 `tests/`，使用临时 Git 仓库、模拟 CNB 响应和 Paseo SDK 测试替身。

日常交付先运行 `npm run typecheck` 和 `npm test`，再重载插件并核对实际入口。隔离 daemon 可以验证创建 worktree、解绑改绑和分支保护；私有仓库的 Git 权限、真实评审回写以及同事能否打开回链，需要在获准用于联调的仓库验收。 [开发方案与验收场景](docs/development-plan.md) · [开发维护约定](AGENTS.md) · [Paseo 安装页概览](OVERVIEW.md)

## 致谢

感谢 **Robin（GitHub 用户名 robbin）** 开源 Better Paseo Antigravity。这个项目展示了怎样让 Paseo 插件复用 daemon 主机上已有的 CLI 登录，也把安装、故障诊断、模拟验证和真实环境验收写得很清楚。Better Paseo CNB 在设计登录流程和编写这些文档时参考了他的工作。 [Robin 的 paseo-antigravity](https://github.com/robbin/paseo-antigravity) · [参考项目的验证记录](https://github.com/robbin/paseo-antigravity/blob/510340d304e4f5894fd793fbe79504944487b544/VALIDATION.md)

## 许可证

本项目采用 Apache License 2.0。 [许可证全文](LICENSE)
