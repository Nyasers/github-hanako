# GitHana（github-hanako）

Git & GitHub tools for HanaAgent：把 git / gh / gpg 三条 CLI 接进 Hana，带隔离的 GPG 签名链路与内嵌自包含运行时，装完即用。

- 形态：full-access 插件（`tools/` 由宿主自动扫描注册 + entry 注册卡路由）
- 工具命名空间：`git_*`（git 操作）· `gh_*`（GitHub CLI）· `gpg_*`（隔离 GPG 身份/公钥）
- 零 npm 依赖 · vendor 内嵌 git/gh/gnupg 随包分发（不入 git 仓库）· 版本见 manifest.json（单一事实源）

## 工具清单

| 工具（导出名） | 文件 | 权限 | 语义 |
|------|------|------|------|
| `git_exec` | tools/git-exec.js | external_side_effect | 任意 git 子命令透传；cwd 必填 + args 必填 + timeoutSec（默认 120 上限 600） |
| `git_status` | tools/git-status.js | readOnly | 状态速览：分支/upstream/ahead-behind/staged/unstaged/untracked |
| `git_log` | tools/git-log.js | readOnly | 最近提交速览（默认 10，1~100） |
| `git_commit` | tools/git-commit.js | external_side_effect | 本地提交（message 走 stdin）；自动 Co-authored-by；**自动 GPG 签名**（隔离 gitconfig `commit.gpgsign=true`）；收尾清理插件环 gpg-agent |
| `git_push` | tools/git-push.js | external_side_effect | force 映射 `--force-with-lease`（非裸 --force）；setUpstream?/dryRun? |
| `gh_exec` | tools/gh-exec.js | external_side_effect | 任意 gh 命令透传（GH_TOKEN 由运行环境注入）；repo?/cwd? |
| `gh_pr` | tools/gh-pr.js | external_side_effect | PR create/list/view/merge |
| `gpg_keygen` | tools/gpg-keygen.js | plugin_output | 隔离 git/GPG 初始化：身份推导 → 隔离 gitconfig → GPG 生成/轮换 → 签名接线 → 公钥落盘 |
| `gpg_pubkey` | tools/gpg-pubkey.js | plugin_output | 返回 `details.card` → 会话流渲染公钥复制卡（route `/pubkey`） |

## 配置

唯一配置键 `token`（GitHub PAT）：插件设置页，或数据目录 `config.json` 兜底。用途：注入 `GH_TOKEN`（gh CLI 认证）+ keygen 的 `gh api user` 身份推导。不配置 token 时 keygen 可传 `email`/`name` 参数显式指定身份。

## 提交者身份与 CoA 署名

- 身份**不配置**：keygen 自动推导 GitHub noreply 邮箱 `{id}+{login}@users.noreply.github.com` + login（token → `gh api user`）；`email`/`name` 参数可显式覆盖（email 必须 = 提交作者邮箱，GPG UID 匹配才 verified）。
- Co-authored-by 固定写死：`HanaAgent <313794804+HanaAgent@users.noreply.github.com>`（@HanaAgent 官方协作署名实体，不承担认证），git_commit 自动追加、已含则跳过。

## GPG 隔离机制（双层接线）

目标：密钥只落插件数据目录 `<dataDir>/gnupg`，签名/验签不碰用户个人 GPG 环。

1. **keygen 侧**：所有 gpg 调用显式 `--homedir <dataDir>/gnupg` 锁定隔离环（不依赖 env）。
2. **签名侧（git）**：隔离 gitconfig 写 `user.signingkey=<fpr>`、`commit.gpgsign=true`、`gpg.program=<vendor gnupg 绝对路径>`。每次 spawn 注入 `GIT_CONFIG_GLOBAL=<dataDir>/gitconfig`、`GNUPGHOME=<dataDir>/gnupg`、`GIT_TERMINAL_PROMPT=0`、token 已配置时 `GH_TOKEN`。

两个必须绕开的坑：

- **系统 scoop gpg 带 `gpgconf.ctl` = 便携模式**：homedir 恒为 scoop home、忽略 `GNUPGHOME` env——不可用于签名接线与 daemon 清理。vendor gnupg 置备时**必须删除 `gpgconf.ctl`**（原生模式 → 认 env）。
- **MinGit 不支持 `gpg.homedir`**、`gpg.program` 不支持带参（整串当 argv0）——所以 `gpg.program` 只能指向「认 GNUPGHOME env」的 gpg：即 vendor gnupg。git spawn vendor gpg 继承注入的 `GNUPGHOME` → 命中隔离环。

## 公钥呈递链路（v3 会话流路由卡）

`gpg_keygen`（生成/轮换，公钥落盘 `<dataDir>/github-toolkit-gpg-pubkey.asc`）→ `gpg_pubkey` 工具返回 `details.card`（route `/pubkey?ts=…`）→ 宿主在**会话流** iframe 渲染插件自身卡页（routes/pubkey.js 读 dataDir 渲染：完整指纹 + 折叠公钥全文 + 「复制公钥到剪贴板」多层复制链（原生 Clipboard API → 宿主桥 → 选区复制，card 面宿主剪贴板能力被拒时的降级）+ GitHub 上传分步指引 + 未生成时的空态引导）。

无 recipe、无手动部署、装完即用。公钥非敏感可进会话流；私钥永不触碰。

## daemon 清理

gpg-agent 被自动拉起后默认常驻，还会按需拉起同环 scdaemon。keygen 与 git-commit 的 execute 均以 `finally` 调 `gpgconf --kill gpg-agent scdaemon` 收尾（vendor gpgconf 认 GNUPGHOME env → 精准命中插件环；双保险跳过条件：dataDir 未登记 / vendor gpgconf 缺失）。验证：签名 commit 后 `Get-Process gpg-agent,scdaemon` 应无插件环进程。

## 设计说明

- 两层结构：`lib/`（exec/bin/context/identity/github 纯函数与封装）+ `tools/` 薄工具；`routes/` + `assets/` 卡页
- 子进程纪律：spawn 参数数组、无 shell 拼接；stdout/stderr 分通道截断 200KB；CRLF 归一 LF；非零退出保留原始输出
- 认证面 CLI 化：gh 走注入的 `GH_TOKEN`，不存凭据在对话
- force 推送安全：`git_push` 只映射 `--force-with-lease`；gh 全程非交互
- cwd 显式传参：git/gh 工具必填仓库绝对路径（checkCwd 预校验）
- 会话流卡 = 工具返回 `details.card`（dsh-hanako 任务卡同款机制），非画布卡

## 安装

正式安装：`node scripts/pack.mjs` 产出 `releases/github-hanako-v<version>.zip`（+`.sha256`，version 取自 manifest.json）→ 拖入宿主插件安装。开发冒烟：`plugin.dev.install`（full-access 授权）装 dev 槽，数据目录为 `plugin-data/dev/github-hanako`。

## 开发结构

```
index.js                # entry：pluginRoutes 挂卡路由（/api/plugins/github-hanako/ 命名空间）
manifest.json           # full-access + ui.hostCapabilities clipboard.writeText
tools/                  # 工具（宿主自动扫描注册）
  lib/exec.js           # runCli 子进程封装 + 隔离 env 注入（applyPluginIsolation）
  lib/bin.js            # vendor 二进制候选链（git/gh/gpg/gpgconf）+ buildBinEnv
  lib/context.js        # 工具上下文单例（dataDir/config）
  lib/identity.js       # noreply 邮箱/login 身份推导纯函数
  lib/github.js         # resolveRepo / validatePositiveInt 纯函数
routes/pubkey.js        # 会话流卡页 route（读 dataDir → 注入模板）
assets/pubkey-card/     # 卡页 HTML/CSS/JS（复制桥 + reportSize + 空态）
scripts/pack.mjs        # 零依赖打包（manifest version 单一事实源）
scripts/fetch-vendor.mjs# git/gh 下载 + sha256 校验
vendor/                 # 内嵌 git/gh/gnupg（.gitignore 忽略，pack 随包分发）
```

## vendor 说明

- git：MinGit 2.55.0（fetch-vendor.mjs 下载，sha256 校验）
- gh：2.95.0（fetch-vendor.mjs 下载，sha256 校验）
- gnupg：2.5.21 手工置备——从 scoop gnupg 复制 `bin/`（含 dll）到 `vendor/gnupg/bin/`，**删除 `gpgconf.ctl`**（原生模式认 GNUPGHOME env，隔离签名前提）；`home/`（个人环）永不复制
