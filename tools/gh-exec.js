/**
 * gh_exec：通用 gh CLI 透传工具（v2 透传层根，GitHub 域）。
 *
 * 把任意 gh 命令以参数数组透传给 gh CLI（认证复用 gh keyring，GitHub 域操作），
 * 无 shell 拼接。与 git_exec 同构：args 为 gh 完整参数列表（首元素为子命令，
 * 如 ["auth", "status"]、["pr", "list"]、["api", "user"]、["issue", "create", "--title", "x"]）。
 *
 * 语义（对齐 spec）：
 * - args 必填；cwd 可选（gh 仓库上下文推断兜底——gh 原生从 cwd 的 git remote 推断；
 *   显式传 cwd 时校验必须存在且为目录，不要求是 git 仓库）；
 * - repo（owner/repo）可选：存在则转 -R <owner/repo> 参数，repo 优先于 cwd 推断；
 *   cwd 与 repo 均缺时若命令需要仓库上下文，gh 自身报错（透传并附引导）；
 * - 超时缺省 120s、上限 600s；非交互（无 TTY，gh 不弹编辑器）；
 * - 未登录时透传 gh 错误并引导 gh auth login。
 */
import { runCli, formatCliResult, checkCwd } from "./lib/exec.js";
import { initToolContext } from "./lib/context.js";
import { resolveRepo } from "./lib/github.js";

export const name = "gh_exec";

export const description = [
  "通用 gh CLI 透传工具（base，GitHub 域）：以 args 参数数组透传任意 gh 命令（无 shell 拼接），",
  "认证复用 gh keyring（需已 gh auth login）。args 首元素为 gh 子命令，",
  "如 [\"auth\",\"status\"]、[\"pr\",\"list\"]、[\"api\",\"user\"]、[\"issue\",\"create\",\"--title\",\"x\"]。",
  "repo 可选（格式 owner/repo，转 -R 参数，优先于 cwd 推断）；cwd 可选（gh 从 git remote 推断仓库，",
  "传了则校验为存在的目录）。PR 生命周期请用 gh_pr（action 子模块，create/list/view/merge）；",
  "issue/release/repo 管理等长尾 gh 操作经此透传。",
  "timeoutSec 可选（默认 120 秒，上限 600 秒）。本工具可能创建/修改 GitHub 远端状态，执行前请确认参数。",
].join(" ");

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "github_cli",
    summary:
      "执行任意 gh CLI 命令（认证复用 gh keyring）：可能创建/修改 GitHub 远端状态（PR/issue/release/仓库设置等，视子命令而定），执行前请确认命令参数",
    ruleId: "github-toolkit-gh-exec",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    args: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "gh 完整参数列表（数组，无 shell 拼接）：首元素为子命令，如 [\"auth\",\"status\"]、[\"pr\",\"list\"]、[\"api\",\"user\"]",
    },
    cwd: {
      type: "string",
      description: "可选：本地仓库绝对路径（gh 从 git remote 推断仓库上下文）；传了则校验为存在的目录",
    },
    repo: {
      type: "string",
      description: "可选：仓库，格式 owner/repo（如 liliMozi/openhanako），存在则转 -R 参数，优先于 cwd 推断",
    },
    timeoutSec: {
      type: "integer",
      minimum: 1,
      maximum: 600,
      description: "超时秒数（可选）：默认 120，上限 600；超时终止进程并返回可读错误",
    },
  },
  required: ["args"],
};

/** gh 提示 → 中文引导（边界条件映射） */
function ghGuidance(stderr) {
  const s = String(stderr || "");
  if (/auth.{0,30}(login|not logged in|invalid)|Please log in/i.test(s)) {
    return "gh 未登录或凭据失效：请先执行 gh auth login（宿主已复用 gh keyring；重登一次后本插件即可用）。";
  }
  if (/could not (determine|find|resolve).*(repo|repository)|not a git repository|no git remotes|GH_REPO/i.test(s)) {
    return "无法确定 GitHub 仓库：请显式传 repo（owner/repo）或在 git 仓库 cwd 内执行（gh 从 remote 推断）。";
  }
  return null;
}

export async function execute(input, ctx) {
  await initToolContext(ctx);
  const argsParam = input?.args;
  if (!Array.isArray(argsParam) || argsParam.length === 0) {
    return "gh_exec 参数错误：args 必填且至少一个元素（gh 子命令，如 [\"auth\",\"status\"]）。";
  }
  let args = argsParam.map((a) => String(a));

  // repo 显式优先：转 -R（全局 flag，置于子命令之前，gh 允许）
  const repoRaw = input?.repo !== undefined && input?.repo !== null ? String(input.repo).trim() : "";
  if (repoRaw) {
    const repoRes = resolveRepo(repoRaw);
    if (repoRes.error) return "gh_exec 参数错误：" + repoRes.error;
    args = ["-R", repoRes.owner + "/" + repoRes.repo, ...args];
  }

  // cwd 可选：传了则校验目录
  let cwd;
  const cwdParam = input?.cwd;
  if (cwdParam !== undefined && cwdParam !== null && String(cwdParam).trim() !== "") {
    const cwdErr = checkCwd(cwdParam);
    if (cwdErr) return "gh_exec 参数错误：" + cwdErr;
    cwd = String(cwdParam).trim();
  }

  const timeoutSec = input?.timeoutSec;
  const result = await runCli("gh", args, { cwd, timeoutSec });
  const text = formatCliResult("gh", args, result);
  if (!result.ok && result.exitCode !== null && result.message) {
    const guide = ghGuidance(result.stderr || result.stdout);
    return guide ? text + "\n" + guide : text;
  }
  return text;
}
