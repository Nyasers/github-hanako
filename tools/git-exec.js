/**
 * git_exec：通用 git CLI 透传工具（v2 透传层根）。
 *
 * 把任意 git 子命令以参数数组透传给本地 git CLI：args 全量透传（首元素为子命令，
 * 如 ["status", "--porcelain"]、["add", "src/a.js"]、["log", "--oneline", "-3"]），
 * 无 shell 拼接（spawn 参数数组），适用于透传层覆盖不到的长尾操作
 * （rebase 等需交互 TTY 的流程除外——本工具非交互参数化执行）。
 *
 * 语义（对齐 spec）：
 * - cwd 必填（绝对路径），仓库上下文一律显式传参，不做工作目录隐式推断；
 * - 超时缺省 120s、上限 600s；stdout/stderr 分通道截断 200KB、CRLF 归一 LF；
 * - 返回可读摘要：命令、exit code、stdout、stderr；
 * - 非零退出保留 git 原始输出（stderr/stdout 原样呈现）；
 * - cwd 不存在/非目录、git 不在 PATH、超时 → 中文可读错误；
 * - cwd 非 git 仓库时透传 git 原始错误并附中文引导。
 * 注意：git_exec 是纯净透传（无隐式 Co-authored-by），提交自动署名请走 git_commit。
 * v0.3：可执行文件经 lib/bin.js 解析（内嵌 MinGit 优先，见 lib/exec.js runCli）。
 */
import { runCli, formatCliResult, checkCwd } from "./lib/exec.js";
import { initToolContext } from "./lib/context.js";

export const name = "git_exec";

export const description = [
  "通用 git CLI 透传工具（base）：以 args 参数数组透传任意 git 子命令到本地 git（无 shell 拼接），",
  "返回命令、exit code 与 stdout/stderr 原文。cwd 必填（仓库绝对路径，显式指定无默认）；",
  "args 为 git 完整参数列表（首元素为子命令），如 [\"status\",\"--porcelain\"]、[\"add\",\"src/a.js\"]、",
  "[\"log\",\"--oneline\",\"-5\"]、[\"diff\",\"--cached\"]。",
  "长尾 git 操作（stash/remote/tag/checkout/merge/rebase 等）可经此透传，无需发版；",
  "高频场景请用 git_status / git_log / git_commit / git_push（带可读化与自动署名）。",
  "timeoutSec 可选（默认 120 秒，上限 600 秒）。注意：透传层原样执行不自动追加 Co-authored-by 署名",
  "（提交署名治理请走 git_commit）。本工具可能修改仓库状态（含远端推送），执行前请确认 cwd 与参数。",
].join(" ");

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "git_local",
    summary:
      "在指定仓库（cwd 绝对路径）执行任意 git 子命令（参数数组透传）：可能修改本地仓库状态（工作区/索引/提交/分支/标签/配置，视子命令而定，含 push 类子命令时亦可能推送远端），执行前请确认 cwd 与命令参数",
    ruleId: "github-toolkit-git-exec",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    cwd: {
      type: "string",
      description: "git 仓库绝对路径（如 E:\\workspace\\my-repo），必填：仓库上下文显式传参，不做隐式推断",
    },
    args: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "git 完整参数列表（数组，无 shell 拼接）：首元素为子命令，如 [\"status\",\"--porcelain\"]、[\"add\",\"src/a.js\"]、[\"log\",\"--oneline\",\"-5\"]",
    },
    timeoutSec: {
      type: "integer",
      minimum: 1,
      maximum: 600,
      description: "超时秒数（可选）：默认 120，上限 600；超时终止进程并返回可读错误",
    },
  },
  required: ["cwd", "args"],
};

/** git 提示 → 中文引导（边界条件映射） */
function gitGuidance(stderr) {
  const s = String(stderr || "");
  if (/not a git repository|not our repo|does not appear to be a git repository/i.test(s)) {
    return "目录不是 git 仓库：git 无法在此执行。请在仓库目录内运行（或先 git init 初始化后重试）。";
  }
  if (/Please tell me who you are|unable to auto-detect email|user\.name|user\.email/i.test(s)) {
    return "git 未配置提交者身份：请先配置 git config user.name / user.email（可用 git_exec 或 git_commit 前配置）。";
  }
  return null;
}

export async function execute(input, ctx) {
  await initToolContext(ctx);
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return "git_exec 参数错误：" + cwdErr;

  const cwd = String(cwdParam).trim();
  const argsParam = input?.args;
  if (!Array.isArray(argsParam) || argsParam.length === 0) {
    return "git_exec 参数错误：args 必填且至少一个元素（git 子命令，如 [\"status\",\"--porcelain\"]）。";
  }
  const args = argsParam.map((a) => String(a));
  const timeoutSec = input?.timeoutSec;

  const result = await runCli("git", args, { cwd, timeoutSec });
  const text = formatCliResult("git", args, result);
  // 非零退出时附加中文引导（如非 git 仓库 / 身份未配置）
  if (!result.ok && result.exitCode !== null && result.message) {
    const guide = gitGuidance(result.stderr || result.stdout);
    return guide ? text + "\n" + guide : text;
  }
  return text;
}
