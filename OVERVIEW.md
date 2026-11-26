# Better Paseo CNB

Better Paseo CNB brings CNB issues, pull requests (PRs), and build checks into Paseo. Use the **CNB inbox (CNB 待办)** in the sidebar to find work across repositories, and the **CNB** workspace panel to work on issues and review PRs. The plugin interface is available only in Simplified Chinese.

## Connect to CNB

The daemon host needs Paseo 0.17.4 or later, Git, and a stable release of cnb-cli 1.24.14 or later. Sign in with `cnb login --host cnb.cool` as the system user running the daemon, then select **检查连接** under **Settings → Plugins → Better Paseo CNB → CNB 连接**. For a remote daemon, run the login command on the remote host. If the daemon cannot find the CLI, set `CNB_CLI_PATH` in its environment to the executable's absolute path.

The plugin discovers CNB repositories from your Paseo projects' Git remotes. If a project has multiple CNB repositories, select one in the **CNB** workspace panel. You can also enter a full CNB repository URL there.

## Issues, pull requests, and build checks

- Filter the inbox for open or assigned issues, PRs awaiting your review, or PRs you opened. Open an issue to read it or create a Git worktree from a local base branch. In the workspace panel, link an issue to your current workspace or choose an agent model and start work with the issue as context. You can also attach an issue to a conversation by pasting its CNB URL.
- After pushing your branch, create a PR from the workspace panel. Review files and submit inline comments, approvals, or requests for changes. You can open a review worktree for a PR from the same repository, or review a fork PR in the panel. Open the PR on CNB to merge it.
- Turn a failed check, build-stage log, or review comment into a draft. You can preview and edit the draft before adding it to an agent's input.

## Repository activity and data access

Repository activity sync is optional and runs once a minute while a Paseo client is connected. Automatic backlink comments are off by default. If you enable them for a repository, the plugin uses the authorized CNB account to post the HTTPS workspace link you confirmed. Anyone who can read the resulting comment can see that link.

The daemon uses your cnb-cli credentials to call the CNB API. API access depends on the CNB account's permissions, and Git fetch and push use the project's existing Git credentials. Workspace associations and confirmed links are stored in Paseo workspace metadata. Repository settings and sync state are stored on the daemon host.

Starting an agent from an issue sends its title, URL, and up to 6,000 characters of its body to the selected agent. Issue attachments and drafts you send also become part of the conversation and can be sent to the agent provider. Submitted PRs, reviews, and backlink comments go to CNB.
