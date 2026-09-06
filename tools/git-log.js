/**
 * git_log：最近提交速览工具（v2 场景只读）。
 *
 * 输出最近 N 条提交（默认 10，1~100）：短 hash、作者名、相对时间、首行。
 * 空仓库（无 HEAD / 尚无提交）返回「暂无提交」不报错。纯读（readOnly）。
 *
 * 实现：git log --pretty=format 定制格式 "%h\t%an\t%ar\t%s"，每条记录占一行、
 * 字段以 TAB 分层——%s（首行主题）不可能含换行（git 提交信息首行以换行结束），
 * 因此换行分层天然防分隔符混淆（spec：用 %x00 或换行分层，此处取换行分层 + TAB 字段）。
 */
import { runCli, checkCwd } from "./lib/exec.js";
import { initToolContext } from "./lib/context.js";

export const name = "git_log";

export const description = [
  "最近提交速览（只读）：输出最近 N 条提交的短 hash、作者名、相对时间与首行说明",
  "（默认最近 10 条，N 可配 1~100）。空仓库（尚无提交）返回「暂无提交」不报错。",
  "cwd 必填（仓库绝对路径，显式指定无默认）。",
  "需要详细提交信息（diff/文件/完整 message）请用 git_exec（如 git show / git log --stat）。",
].join(" ");

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    cwd: {
      type: "string",
      description: "git 仓库绝对路径（如 E:\\workspace\\my-repo），必填",
    },
    n: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 10,
      description: "返回条数：默认 10，范围 1~100，越界自动收敛到边界",
    },
  },
  required: ["cwd"],
};

export async function execute(input, ctx) {
  await initToolContext(ctx);
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return "git_log 参数错误：" + cwdErr;
  const cwd = String(cwdParam).trim();

  // n 归一：默认 10，1~100 收敛
  let n = 10;
  if (input?.n !== undefined && input?.n !== null && input?.n !== "") {
    const num = Number(input.n);
    if (Number.isFinite(num)) n = Math.min(100, Math.max(1, Math.floor(num)));
  }

  const r = await runCli(
    "git",
    ["log", "-n", String(n), "--pretty=format:%h%x09%an%x09%ar%x09%s"],
    { cwd },
  );
  if (!r.ok) {
    const raw = (r.stderr || r.stdout || "").trim();
    // 空仓库（分支尚无任何提交）→ 按规范返回「暂无提交」，不当作错误
    if (/does not have any commits yet|your current branch.*does not have any commits|fatal: bad default revision/i.test(raw)) {
      return "git_log：" + cwd + " 仓库暂无提交（该分支尚无 commit，HEAD 不存在）。";
    }
    if (/not a git repository|does not appear to be a git repository|not our repo/i.test(raw)) {
      return "git_log：当前目录不是 git 仓库（git 提示：" + (raw.split("\n")[0] || raw) + "）。请在仓库目录内执行。";
    }
    return "git_log 执行失败：\n" + (r.message || raw || "未知错误");
  }

  const text = r.stdout || "";
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  if (lines.length === 0) {
    return "git_log：" + cwd + " 仓库暂无提交（该分支尚无 commit）。";
  }

  const out = ["最近 " + lines.length + " 条提交（" + cwd + "）："];
  lines.forEach((l, i) => {
    // 字段：hash / author / relative / subject（%s 不含换行，TAB 分层解析）
    const idx1 = l.indexOf("\t");
    const idx2 = idx1 === -1 ? -1 : l.indexOf("\t", idx1 + 1);
    const idx3 = idx2 === -1 ? -1 : l.indexOf("\t", idx2 + 1);
    if (idx3 === -1) {
      out.push((i + 1) + ". " + l);
      return;
    }
    const hash = l.slice(0, idx1);
    const author = l.slice(idx1 + 1, idx2);
    const when = l.slice(idx2 + 1, idx3);
    const subject = l.slice(idx3 + 1);
    out.push((i + 1) + ". " + hash + "  " + author + "  " + when + "  " + subject);
  });
  return out.join("\n");
}
