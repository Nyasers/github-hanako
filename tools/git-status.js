/**
 * git_status：仓库状态速览工具（v2 场景只读）。
 *
 * 输出：当前分支、upstream、ahead/behind、已暂存 / 未暂存 / 未跟踪三组文件明细
 * （porcelain v1 解析，状态字母可读化），工作区干净时明确提示。纯读（readOnly），
 * 不改动仓库任何状态。
 *
 * 实现：单次 git status --porcelain=v1 -b --untracked-files=all（含分支头），
 * 头部形如 "## main...origin/main [ahead 2, behind 3]"，一次解析分支/上游/领先落后；
 * 游离 HEAD / 尚无提交（unborn）等特殊形态做文本分支；游离态补一次 rev-parse 取短 hash。
 * -c core.quotepath=false 保证中文路径原样显示（不转义为八进制）。
 */
import { runCli, checkCwd } from "./lib/exec.js";
import { initToolContext } from "./lib/context.js";

export const name = "git_status";

export const description = [
  "仓库状态速览（只读）：输出当前分支、upstream、ahead/behind、以及已暂存 / 未暂存 / 未跟踪三组文件明细",
  "（porcelain v1 解析，状态字母可读化：A=新增 M=修改 D=删除 R=重命名 U=冲突 ??=未跟踪），",
  "工作区干净时明确提示。cwd 必填（仓库绝对路径，显式指定无默认）。",
  "只读不修改仓库；需要执行任意 git 操作请用 git_exec。",
].join(" ");

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    cwd: {
      type: "string",
      description: "git 仓库绝对路径（如 E:\\workspace\\my-repo），必填",
    },
  },
  required: ["cwd"],
};

/** 未合并（冲突）状态码集合 */
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** porcelain 单字母 → 中文可读（空格=无变更不应出现） */
function readableLetter(ch) {
  switch (ch) {
    case "A": return "新增";
    case "M": return "修改";
    case "D": return "删除";
    case "R": return "重命名";
    case "C": return "复制";
    case "T": return "类型变更";
    case "U": return "冲突";
    case "?": return "未跟踪";
    default: return ch;
  }
}

/**
 * 解析 porcelain v1 -b 的分支头（"## main...origin/main [ahead 2, behind 3]" 等形态）。
 * @param {string} headerLine 不含 "## " 前缀
 */
function parseBranchHeader(headerLine) {
  const info = {
    branch: null, upstream: null, ahead: null, behind: null,
    gone: false, detached: false, unborn: false,
  };
  let rest = headerLine.trim();
  if (rest.startsWith("No commits yet on ")) {
    info.unborn = true;
    rest = rest.slice("No commits yet on ".length).trim();
  }
  if (/^HEAD \(no branch\)/.test(rest)) {
    info.detached = true;
    rest = rest.replace(/^HEAD \(no branch\)/, "HEAD").trim();
  }
  const dotIdx = rest.indexOf("...");
  if (dotIdx === -1) {
    info.branch = rest;
    return info;
  }
  info.branch = rest.slice(0, dotIdx);
  let tail = rest.slice(dotIdx + 3);
  const metaIdx = tail.indexOf(" [");
  let meta = "";
  if (metaIdx !== -1) {
    meta = tail.slice(metaIdx + 2);
    if (meta.endsWith("]")) meta = meta.slice(0, -1);
    tail = tail.slice(0, metaIdx);
  }
  info.upstream = tail.trim() || null;
  if (meta === "gone") {
    info.gone = true;
  } else {
    const m = meta.match(/^ahead (\d+)(?:, behind (\d+))?$/);
    if (m) {
      info.ahead = Number(m[1]);
      info.behind = m[2] !== undefined ? Number(m[2]) : 0;
    } else {
      const m2 = meta.match(/^behind (\d+)$/);
      if (m2) info.behind = Number(m2[1]);
    }
  }
  return info;
}

/**
 * 解析 porcelain v1 行（不含分支头）为四组：staged / unstaged / unmerged / untracked。
 * 每条 { label: 可读状态, text: 展示路径（重命名含 →） }。
 */
function parsePorcelain(stdout) {
  const staged = [], unstaged = [], unmerged = [], untracked = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith("## ")) continue;
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let pathText = line.slice(3);
    // v1 重命名/复制形态："R  old -> new"（-z 外的文本展示）
    const arrowIdx = pathText.indexOf(" -> ");
    if (arrowIdx !== -1) {
      const from = pathText.slice(0, arrowIdx);
      const to = pathText.slice(arrowIdx + 4);
      pathText = from + " → " + to;
    }
    if (xy === "??") {
      untracked.push({ label: "未跟踪", text: pathText });
      continue;
    }
    if (UNMERGED.has(xy)) {
      unmerged.push({ label: "冲突（未合并）", text: pathText + "（" + xy + "）" });
      continue;
    }
    const x = xy[0];
    const y = xy[1];
    if (x !== " ") staged.push({ label: readableLetter(x) || x, text: pathText });
    if (y !== " ") unstaged.push({ label: readableLetter(y) || y, text: pathText });
  }
  return { staged, unstaged, unmerged, untracked };
}

/** 组渲染：标题 + 明细（含数量）；空组返回 null */
function renderGroup(title, items, note) {
  if (!items.length) return null;
  const lines = [title + "（" + items.length + "）" + (note || "")];
  for (const it of items) lines.push("  [" + it.label + "] " + it.text);
  return lines;
}

export async function execute(input, ctx) {
  await initToolContext(ctx);
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return "git_status 参数错误：" + cwdErr;
  const cwd = String(cwdParam).trim();

  const r = await runCli("git", ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-b", "--untracked-files=all"], { cwd });
  if (!r.ok) {
    // 非 git 仓库 → 透传 git 原始错误 + 中文引导
    const raw = (r.stderr || r.stdout || "").trim();
    if (/not a git repository|does not appear to be a git repository|not our repo/i.test(raw)) {
      return "git_status：当前目录不是 git 仓库（git 提示：" + (raw.split("\n")[0] || raw) + "）。请在仓库目录内执行。";
    }
    return "git_status 执行失败：\n" + (r.message || raw || "未知错误");
  }

  const linesOut = r.stdout || "";
  const rawLines = linesOut.split("\n");
  let header = null;
  const body = [];
  for (const l of rawLines) {
    if (l.startsWith("## ") && header === null) header = l.slice(3);
    else if (l !== "") body.push(l);
  }

  const info = header ? parseBranchHeader(header) : { branch: null, upstream: null };
  const groups = parsePorcelain(body.join("\n"));
  const totalChanges = groups.staged.length + groups.unstaged.length + groups.unmerged.length + groups.untracked.length;

  const out = [];
  out.push("仓库：" + cwd);

  // —— 分支 / 上游 / 同步状态 ——
  if (info.unborn) {
    out.push("分支：" + (info.branch || "?") + "（仓库尚无提交：初始化后尚无 commit，首次提交可用 git_commit）");
  } else if (info.detached) {
    // 游离 HEAD：补一次 rev-parse 取短 hash（正常分支不触发第二次调用）
    const shaR = await runCli("git", ["rev-parse", "--short", "HEAD"], { cwd });
    const sha = shaR.ok ? shaR.stdout.trim() : "";
    out.push("分支：（游离 HEAD）" + (sha ? "· 当前提交 " + sha : "") + "（不在分支上，直接提交会游离；如需推送请先检出/创建分支）");
  } else {
    out.push("分支：" + (info.branch || "?"));
  }

  if (!info.unborn) {
    if (!info.upstream) {
      out.push("上游：无跟踪分支（首次推送可用 git_push 的 setUpstream=true 建立 origin 跟踪）");
    } else if (info.gone) {
      out.push("上游：" + info.upstream + "（上游分支已被删除 gone）");
    } else {
      let syncText = "已与上游同步";
      if (info.ahead && info.behind) syncText = "领先 " + info.ahead + " 且落后 " + info.behind + "（需推送且需拉取合并）";
      else if (info.ahead) syncText = "领先 " + info.ahead + "（可推送 git_push）";
      else if (info.behind) syncText = "落后 " + info.behind + "（需拉取合并）";
      out.push("上游：" + info.upstream + " · " + syncText);
    }
  }

  // —— 变更明细 ——
  if (totalChanges === 0) {
    out.push("");
    out.push("工作区干净：无已暂存 / 未暂存 / 未跟踪变更。");
    return out.join("\n");
  }

  out.push("");
  out.push("变更总数：" + totalChanges + (info.branch ? " · 分支 " + info.branch : "") + "");
  const blocks = [
    renderGroup("已暂存（staged）", groups.staged, ""),
    renderGroup("未暂存（unstaged）", groups.unstaged, ""),
    renderGroup("未合并（冲突，需解决后 git add）", groups.unmerged, ""),
    renderGroup("未跟踪（untracked）", groups.untracked, ""),
  ];
  for (const b of blocks) if (b) out.push(...b, "");
  return out.join("\n").trimEnd();
}
