/**
 * gh_pr：PR 生命周期工具（v2 场景写）——action 子模块 create/list/view/merge。
 *
 * 一工具内按 action 分支（照 dsh_session 混合 action 先例：整体标 external_side_effect，
 * 含只读 action 也送审，避免子模块拆分膨胀工具面）。认证复用 gh keyring（gh auth login）。
 *
 * 公共上下文：repo（owner/repo，转 -R 参数）显式优先；cwd 可选（gh 从 git remote 推断仓库，
 * 兜底）；create 缺省 title 时需要 cwd 取 HEAD commit 首行。全命令非交互（gh 无 TTY 不弹编辑器）。
 *
 * - create：base?（缺省 gh 默认目标分支）、title?（缺省取 cwd 内 HEAD commit 首行；cwd 与 title
 *   均缺 → 引导）、body?、draft?（--draft）；输出新建 PR 的 URL 与编号。
 * - list：state?（open 默认/closed/all）+ limit?（默认 10 ≤50）；输出编号/标题/分支/state/时间 列表。
 * - view：prNumber?（缺省 = 当前分支关联 PR，gh 自动推断；无关联 PR → 可读「当前分支无关联 PR」）+
 *   输出 title/state/head→base/审查状态/合并状态/URL/body（截断）。
 * - merge：prNumber 必填 + method?（merge 默认/squash/rebase → --merge/--squash/--rebase）+
 *   deleteBranch?（--delete-branch）。合并不可撤销，描述注明。
 */
import { runCli, checkCwd } from "./lib/exec.js";
import { initToolContext } from "./lib/context.js";
import { resolveRepo, validatePositiveInt } from "./lib/github.js";

export const name = "gh_pr";

export const description = [
  "GitHub Pull Request 生命周期工具（action 子模块：create/list/view/merge）。认证复用 gh keyring。",
  "repo 可选（格式 owner/repo，转 -R，显式优先）；cwd 可选（gh 从 git remote 推断仓库兜底）。",
  "create：base?（缺省 gh 默认目标分支）+ title?（缺省取 cwd 内 HEAD commit 首行，cwd 与 title 均缺则引导）",
  "+ body? + draft?（--draft），输出新 PR 的 URL 与编号（创建是远端写操作）。",
  "list：state?（open 默认/closed/all）+ limit?（默认 10，1~50），输出编号/标题/分支/state/时间。",
  "view：prNumber?（正整数；缺省 = 当前分支关联 PR，无关联 PR 返回提示），输出状态/分支/审查/合并/URL/正文。",
  "merge：prNumber 必填 + method?（merge 默认/squash/rebase）+ deleteBranch?（--delete-branch）。",
  "注意：merge 合并 PR 不可撤销（会合并代码并可能删除源分支），执行前请确认编号与参数；本工具无交互提示。",
].join(" ");

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "github_pr",
    summary:
      "操作 GitHub 远端 PR（gh CLI，认证复用 gh keyring）：create 创建 PR、merge 合并 PR（不可撤销，可带 --delete-branch 删除源分支）均修改 GitHub 远端状态；list/view 为只读查询但随本工具整体送审。执行前请确认 repo/prNumber 与参数",
    ruleId: "github-toolkit-gh-pr",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "list", "view", "merge"],
      description: "子模块：create=创建 PR / list=列出 PR / view=查看 PR（详情）/ merge=合并 PR（不可撤销）",
    },
    repo: {
      type: "string",
      description: "可选：仓库，格式 owner/repo（如 liliMozi/openhanako）；显式传则转 -R，优先于 cwd 推断",
    },
    cwd: {
      type: "string",
      description: "可选：本地仓库绝对路径（gh 从 git remote 推断仓库；create 缺省 title 时取 HEAD commit 首行）",
    },
    timeoutSec: {
      type: "integer",
      minimum: 1,
      maximum: 600,
      description: "超时秒数（可选）：默认 120，上限 600",
    },
    base: {
      type: "string",
      description: "仅 create：目标分支（缺省由 gh 用仓库默认分支，如 main）",
    },
    title: {
      type: "string",
      description: "仅 create：PR 标题（缺省取 cwd 内 HEAD commit 首行；cwd 与 title 均缺则返回引导）",
    },
    body: {
      type: "string",
      description: "仅 create：PR 正文（可选，支持 Markdown 与中文）",
    },
    draft: {
      type: "boolean",
      description: "仅 create：以草稿（draft）创建 PR",
    },
    state: {
      type: "string",
      enum: ["open", "closed", "all"],
      description: "仅 list：PR 状态过滤，默认 open",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "仅 list：返回条数，默认 10，上限 50",
    },
    prNumber: {
      type: "integer",
      minimum: 1,
      description: "view/merge：PR 编号（正整数）；view 缺省 = 当前分支关联 PR；merge 必填",
    },
    method: {
      type: "string",
      enum: ["merge", "squash", "rebase"],
      description: "仅 merge：合并方式（默认 merge）：merge=--merge / squash=--squash / rebase=--rebase",
    },
    deleteBranch: {
      type: "boolean",
      description: "仅 merge：合并后删除源分支（--delete-branch）",
    },
  },
  required: ["action"],
};

const CONTEXT_GUIDANCE =
  "gh_pr 需要 GitHub 仓库上下文：请显式传 repo（格式 owner/repo，转 -R）或在 git 仓库 cwd 内执行（gh 从 remote 推断）。";

/** gh 失败输出 → 中文引导（auth / 仓库推断） */
function ghGuidance(stderr, stdout) {
  const s = String(stderr || "") + "\n" + String(stdout || "");
  if (/Please log in|auth.*(login|required)|not logged in|invalid auth/i.test(s)) {
    return "gh 未登录或凭据失效：请先执行 gh auth login（宿主复用 gh keyring，重登一次即可）。";
  }
  if (/could not (determine|find|resolve)|not a git repository|no git remotes/i.test(s)) {
    return "无法确定 GitHub 仓库：" + CONTEXT_GUIDANCE;
  }
  return null;
}

/** repo 解析：显式提供则必须合法；空/缺省 → null（走 cwd 推断） */
function parseRepo(repoParam) {
  const raw = repoParam !== undefined && repoParam !== null ? String(repoParam).trim() : "";
  if (!raw) return null;
  const res = resolveRepo(raw);
  if (res.error) return { error: res.error };
  return res;
}

/** 格式化时间 ISO → 本地 yyyy-MM-dd HH:mm */
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/** reviewDecision / mergeStateStatus 中文可读 */
function reviewText(v) {
  const map = {
    APPROVED: "已批准（APPROVED）",
    CHANGES_REQUESTED: "请求修改（CHANGES_REQUESTED）",
    REVIEW_REQUIRED: "等待审查（REVIEW_REQUIRED）",
    COMMENTED: "有评论（COMMENTED）",
  };
  if (v === null || v === undefined || v === "") return "无审查数据";
  return map[v] || v;
}
function mergeStateText(v) {
  const map = {
    BLOCKED: "被阻断（BLOCKED）",
    BEHIND: "落后于目标分支（BEHIND）",
    BLOCKING: "阻断中（BLOCKING）",
    CLEAN: "可合并（CLEAN）",
    DIRTY: "有冲突（DIRTY）",
    DRAFT: "草稿（DRAFT）",
    HAS_HOOKS: "含钩子（HAS_HOOKS）",
    UNKNOWN: "未知（UNKNOWN）",
    UNSTABLE: "检查未通过（UNSTABLE）",
    MERGEABLE: "可合并（MERGEABLE）",
  };
  if (v === null || v === undefined || v === "") return "无合并状态";
  return map[v] || v;
}

/** view --json 公共字段 */
const VIEW_JSON_FIELDS = "number,title,state,isDraft,headRefName,baseRefName,author,reviewDecision,mergeStateStatus,url,body,createdAt,mergedAt";

export async function execute(input, ctx) {
  await initToolContext(ctx);
  const action = String(input?.action ?? "").trim();
  if (!["create", "list", "view", "merge"].includes(action)) {
    return "gh_pr 参数错误：action 必须是 create / list / view / merge（收到：" + (action || "空") + "）。";
  }

  const repoRes = parseRepo(input?.repo);
  if (repoRes && repoRes.error) return "gh_pr 参数错误：" + repoRes.error;

  // cwd 可选：传了必须存在且为目录
  let cwd = "";
  const cwdParam = input?.cwd;
  if (cwdParam !== undefined && cwdParam !== null && String(cwdParam).trim() !== "") {
    const cwdErr = checkCwd(cwdParam);
    if (cwdErr) return "gh_pr 参数错误：" + cwdErr;
    cwd = String(cwdParam).trim();
  }
  const timeoutSec = input?.timeoutSec;

  // 统一仓库上下文前置检查：repo 或 cwd 至少其一（gh pr * 都需要确定仓库）
  if (!repoRes && !cwd) {
    return "gh_pr（action=" + action + "）参数错误：未提供任何仓库上下文。\n" + CONTEXT_GUIDANCE;
  }

  const repoFlag = repoRes ? ["-R", repoRes.owner + "/" + repoRes.repo] : [];
  const repoLabel = repoRes ? repoRes.owner + "/" + repoRes.repo : "（cwd 推断）";

  // 运行 gh 并统一把失败转可读（透传 gh 原文 + 中文引导）
  async function runGh(args) {
    const r = await runCli("gh", args, { cwd: cwd || undefined, timeoutSec });
    if (!r.ok && r.exitCode !== null) {
      const raw = ((r.stderr || "") + "\n" + (r.stdout || "")).trim();
      const guide = ghGuidance(r.stderr, r.stdout);
      return { ok: false, raw, guide, result: r };
    }
    return { ok: r.ok, raw: ((r.stdout || "") + "\n" + (r.stderr || "")).trim(), result: r };
  }

  try {
    if (action === "create") return await doCreate(input, { cwd, repoRes, repoFlag, runGh });
    if (action === "list") return await doList(input, { repoRes, repoFlag, repoLabel, runGh });
    if (action === "view") return await doView(input, { repoRes, repoFlag, runGh });
    return await doMerge(input, { repoRes, repoFlag, repoLabel, runGh });
  } catch (e) {
    return "gh_pr（action=" + action + "）执行异常：" + (e && e.message ? e.message : String(e));
  }
}

/** create：title 缺省取 cwd HEAD commit 首行 */
async function doCreate(input, { cwd, repoRes, repoFlag, runGh }) {
  let title = input?.title !== undefined && input?.title !== null ? String(input.title).trim() : "";
  if (!title) {
    if (!cwd) {
      return "gh_pr create 参数错误：title 缺省需要 cwd（取当前分支 HEAD commit 首行），但未传 cwd。请传 title 或 cwd。";
    }
    const headR = await runCli("git", ["log", "-1", "--format=%s"], { cwd });
    if (!headR.ok) {
      const raw = (headR.stderr || "").trim();
      if (/does not have any commits yet/i.test(raw)) {
        return "gh_pr create 无法推导 title：cwd 仓库尚无提交（HEAD 不存在）。请显式传 title。";
      }
      if (/not a git repository/i.test(raw)) {
        return "gh_pr create：cwd 不是 git 仓库（git 提示：" + (raw.split("\n")[0] || raw) + "）。请传仓库 cwd 或显式 title+repo。";
      }
      return "gh_pr create 读取 HEAD title 失败：" + (raw || headR.message);
    }
    title = headR.stdout.trim();
    if (!title) {
      return "gh_pr create 无法推导 title：HEAD commit 无首行内容，请显式传 title。";
    }
  }

  const args = ["pr", "create", ...repoFlag, "--title", title];
  const base = input?.base !== undefined && input?.base !== null ? String(input.base).trim() : "";
  if (base) args.push("--base", base);
  const body = input?.body !== undefined && input?.body !== null ? String(input.body) : "";
  if (body.trim()) args.push("--body", body);
  if (input?.draft === true) args.push("--draft");

  const res = await runGh(args);
  if (!res.ok) {
    return (
      "gh_pr create 执行失败：\n" + (res.raw || res.result.message) +
      (res.guide ? "\n" + res.guide : "")
    );
  }

  // 解析新建 PR 的 URL 与编号（gh 成功输出含 https://github.com/<o>/<r>/pull/<n>）
  const combined = res.raw;
  const urls = combined.match(/https?:\/\/[^\s"'<>)]+\/pull\/\d+/g) || [];
  const url = urls.length ? urls[urls.length - 1].trim() : "";
  const numM = url.match(/\/pull\/(\d+)$/);
  const lines = ["gh_pr create 完成："];
  if (url) {
    lines.push("PR URL：" + url);
    lines.push("PR 编号：#" + (numM ? numM[1] : "?"));
  } else {
    lines.push("（未能从 gh 输出解析 URL——见下方原始输出）");
    lines.push(res.raw);
  }
  lines.push("标题：" + title);
  if (body.trim()) lines.push("body 长度：" + body.length + " 字符");
  if (input?.draft === true) lines.push("草稿：是（--draft）");
  return lines.join("\n");
}

/** list：gh pr list --json 解析后格式化 */
async function doList(input, { repoRes, repoFlag, repoLabel, runGh }) {
  const state = input?.state !== undefined && input?.state !== null ? String(input.state).trim() : "open";
  if (!["open", "closed", "all"].includes(state)) {
    return "gh_pr list 参数错误：state 必须是 open / closed / all（收到：" + state + "）。";
  }
  let limit = 10;
  if (input?.limit !== undefined && input?.limit !== null && input?.limit !== "") {
    const n = Number(input.limit);
    if (!Number.isInteger(n) || n <= 0) return "gh_pr list 参数错误：limit 必须是正整数。";
    limit = Math.min(50, n);
  }

  const args = [
    "pr", "list", ...repoFlag,
    "--state", state,
    "--limit", String(limit),
    "--json", "number,title,headRefName,state,createdAt,url",
  ];
  const res = await runGh(args);
  if (!res.ok) {
    return "gh_pr list 执行失败：\n" + (res.raw || res.result.message) + (res.guide ? "\n" + res.guide : "");
  }

  let items = [];
  try {
    const parsed = JSON.parse(res.result.stdout || "[]");
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    return "gh_pr list：gh 输出非预期（非 JSON），原始输出如下：\n" + res.raw;
  }

  if (items.length === 0) {
    return "gh_pr list（" + repoLabel + " · state=" + state + "）：没有匹配的 PR。";
  }
  const out = ["gh_pr list（" + repoLabel + " · state=" + state + " · " + items.length + " 条）："];
  for (const it of items) {
    out.push(
      "#" + it.number + " [" + (it.state || "?") + "] " + (it.headRefName || "?") +
      " · " + fmtTime(it.createdAt) + " · " + (it.title || ""),
    );
    if (it.url) out.push("  " + it.url);
  }
  return out.join("\n");
}

/** view：gh pr view --json 解析后格式化 */
async function doView(input, { repoRes, repoFlag, runGh }) {
  let numStr = "";
  if (input?.prNumber !== undefined && input?.prNumber !== null && input?.prNumber !== "") {
    const numRes = validatePositiveInt(input.prNumber, "prNumber");
    if (numRes.error) return "gh_pr view 参数错误：" + numRes.error;
    numStr = String(numRes.value);
  }

  const args = ["pr", "view", ...(numStr ? [numStr] : []), ...repoFlag, "--json", VIEW_JSON_FIELDS];
  const res = await runGh(args);
  if (!res.ok) {
    const raw = res.raw || "";
    // 无编号 + 分支无关联 PR → 可读提示（不误报错误）
    if (!numStr && /no (open )?pull requests? (found|associated)|no PR/i.test(raw)) {
      return "gh_pr view：当前分支无关联 PR（gh 提示：" + (raw.split("\n")[0] || raw) + "）。";
    }
    if (/could not (find|resolve).*(#|pull)|not found|GraphQL:.*not found/i.test(raw) && numStr) {
      return "gh_pr view：PR #" + numStr + " 不存在或不可见（" + repoLabelOf(repoRes) + "）。";
    }
    return "gh_pr view 执行失败：\n" + raw + (res.guide ? "\n" + res.guide : "");
  }

  let pr;
  try {
    const parsed = JSON.parse(res.result.stdout || "{}");
    pr = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return "gh_pr view：gh 输出非预期（非 JSON），原始输出如下：\n" + res.raw;
  }
  if (!pr || typeof pr !== "object") {
    return "gh_pr view：未取到 PR 数据。原始输出：\n" + res.raw;
  }

  const author = pr.author && pr.author.login ? "@" + pr.author.login : "?";
  const out = [];
  out.push("PR #" + pr.number + "：「" + (pr.title || "（无标题）") + "」");
  out.push(
    "状态：" + String(pr.state || "?") + (pr.isDraft ? "（草稿 draft）" : "") +
    " · 分支：" + (pr.headRefName || "?") + " → " + (pr.baseRefName || "?") +
    " · 作者：" + author,
  );
  out.push("审查：" + reviewText(pr.reviewDecision) + " · 合并：" + mergeStateText(pr.mergeStateStatus));
  if (pr.createdAt) out.push("创建于：" + fmtTime(pr.createdAt) + (pr.mergedAt ? " · 合并于：" + fmtTime(pr.mergedAt) : ""));
  if (pr.url) out.push("URL：" + pr.url);
  const body = pr.body !== null && pr.body !== undefined ? String(pr.body) : "";
  const BODY_MAX = 2000;
  out.push("");
  out.push("—— 正文" + (body.length > BODY_MAX ? "（截断，共 " + body.length + " 字符）" : "") + " ——");
  out.push(body ? (body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "…" : body) : "（无正文）");
  return out.join("\n");
}

function repoLabelOf(repoRes) {
  return repoRes ? repoRes.owner + "/" + repoRes.repo : "？";
}

/** merge：合并（不可撤销），完成后用 view 确认状态 */
async function doMerge(input, { repoRes, repoFlag, repoLabel, runGh }) {
  const numRes = validatePositiveInt(input?.prNumber, "prNumber");
  if (numRes.error) return "gh_pr merge 参数错误：" + numRes.error + "（merge 必须指定要合并的 PR 编号）。";
  const num = numRes.value;

  const method = input?.method !== undefined && input?.method !== null ? String(input.method).trim() : "merge";
  if (!["merge", "squash", "rebase"].includes(method)) {
    return "gh_pr merge 参数错误：method 必须是 merge / squash / rebase（收到：" + method + "）。";
  }
  const methodFlag = "--" + method;
  const deleteBranch = input?.deleteBranch === true;

  const args = ["pr", "merge", String(num), ...repoFlag, methodFlag];
  if (deleteBranch) args.push("--delete-branch");

  const res = await runGh(args);
  if (!res.ok) {
    const raw = res.raw || "";
    if (/already merged/i.test(raw)) {
      return "gh_pr merge：PR #" + num + " 已经合并（不可重复合并）。\n" + raw;
    }
    if (/not mergeable|merge conflict|conflict/i.test(raw)) {
      return "gh_pr merge：PR #" + num + " 存在冲突或合并检查未通过：\n" + raw + (res.guide ? "\n" + res.guide : "");
    }
    return "gh_pr merge 执行失败（PR #" + num + "）：\n" + raw + (res.guide ? "\n" + res.guide : "");
  }

  // 成功：确认合并终态（view --json state/mergedAt/url）
  const out = ["gh_pr merge 已执行（PR #" + num + " · " + repoLabel + " · method=" + method + (deleteBranch ? " · deleteBranch" : "") + "）："];
  const conf = await runGh(["pr", "view", String(num), ...repoFlag, "--json", "state,mergedAt,url"]);
  if (conf.ok) {
    try {
      const parsed = JSON.parse(conf.result.stdout || "{}");
      const p = Array.isArray(parsed) ? parsed[0] : parsed;
      if (p && p.state === "MERGED") {
        out.push("状态：MERGED（已合并）" + (p.mergedAt ? " · 合并于 " + fmtTime(p.mergedAt) : ""));
        if (p.url) out.push("URL：" + p.url);
        return out.join("\n");
      }
      if (p) out.push("状态：" + String(p.state) + "（gh 返回，可能因仓库规则仍在处理中）");
    } catch {
      /* 确认失败：回落原始输出 */
    }
  }
  if (res.raw) out.push(res.raw);
  return out.join("\n");
}
