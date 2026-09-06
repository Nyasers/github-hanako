/**
 * git_push：推送工具（v2 场景写）——本地提交推送到远端。
 *
 * 语义（对齐 spec）：
 * - cwd 必填（仓库）；branch 缺省 = 当前分支（git rev-parse --abbrev-ref HEAD）；
 *   remote 缺省 "origin"；branch 未指定时简化为 "git push <remote>"（推配置的跟踪分支）；
 *   显式 branch 时带分支名推送。
 * - setUpstream=true → -u（建立跟踪）；force=true → --force-with-lease（安全 force，
 *   非裸 --force——防覆盖他人提交；裸 force 需走 git_exec 显式传）；dryRun=true → --dry-run（只验证不真推）。
 * - 返回推送结果摘要（含远端/分支/参数与 git 原文）。
 */
import { runCli, checkCwd } from "./lib/exec.js";
import { initToolContext } from "./lib/context.js";

export const name = "git_push";

export const description = [
  "把本地提交推送到远端仓库（默认 origin，可指定 remote/branch）。",
  "cwd 必填（仓库绝对路径）。branch 缺省 = 当前分支名；remote 缺省 origin。",
  "setUpstream=true 时带 -u 建立跟踪分支；force=true 映射为 --force-with-lease（安全 force，",
  "不会覆盖他人新提交，裸 --force 需走 git_exec 显式传）；dryRun=true 只做 --dry-run 验证不真推。",
  "推送会更新远端分支引用（不可随意撤销），执行前请确认 cwd/remote/branch。",
].join(" ");

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "git_remote",
    summary:
      "把本地提交推送到远端仓库（默认 origin，更新远端分支引用；dryRun 仅验证不真推；force 仅映射 --force-with-lease 安全强推），执行前请确认 cwd、remote、branch",
    ruleId: "github-toolkit-git-push",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    cwd: {
      type: "string",
      description: "git 仓库绝对路径（如 E:\\workspace\\my-repo），必填",
    },
    branch: {
      type: "string",
      description: "可选：要推送的分支名；缺省 = 当前分支（git rev-parse --abbrev-ref HEAD）",
    },
    remote: {
      type: "string",
      description: "可选：远端名，默认 origin",
    },
    setUpstream: {
      type: "boolean",
      description: "可选：带 -u 建立上游跟踪分支（首次推送推荐）",
    },
    force: {
      type: "boolean",
      description: "可选：强制推送——映射 --force-with-lease（安全 force，拒绝覆盖他人新提交）；裸 --force 请走 git_exec",
    },
    dryRun: {
      type: "boolean",
      description: "可选：只做 --dry-run 演练，验证可推送性，不真正更新远端",
    },
  },
  required: ["cwd"],
};

export async function execute(input, ctx) {
  await initToolContext(ctx);
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return "git_push 参数错误：" + cwdErr;
  const cwd = String(cwdParam).trim();

  const remote = input?.remote !== undefined && input?.remote !== null && String(input.remote).trim() !== ""
    ? String(input.remote).trim()
    : "origin";
  const setUpstream = input?.setUpstream === true;
  const force = input?.force === true;
  const dryRun = input?.dryRun === true;

  // 缺省分支 = 当前分支；游离 HEAD 无分支名 → 引导
  let branch = input?.branch !== undefined && input?.branch !== null ? String(input.branch).trim() : "";
  if (!branch) {
    const brR = await runCli("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    if (!brR.ok) {
      const raw = (brR.stderr || "").trim();
      if (/not a git repository/i.test(raw)) {
        return "git_push：当前目录不是 git 仓库（git 提示：" + (raw.split("\n")[0] || raw) + "）。请在仓库目录内执行。";
      }
      if (/HEAD|ambiguous/i.test(raw)) {
        return "git_push：无法确定当前分支（游离 HEAD 或仓库尚无提交）：请显式传 branch 参数，或先检出分支。";
      }
      return "git_push 读取分支失败：\n" + (brR.message || raw);
    }
    branch = brR.stdout.trim();
    if (!branch || branch === "HEAD") {
      return "git_push：当前处于游离 HEAD 或分支未命名，无法推送。请先检出/创建分支（git_exec：checkout -b <branch>）或显式传 branch。";
    }
  }

  const args = ["push"];
  if (dryRun) args.push("--dry-run");
  if (force) args.push("--force-with-lease");
  if (setUpstream) args.push("-u");
  args.push(remote, branch);

  const r = await runCli("git", args, { cwd });
  const text = r.ok
    ? [
        "推送成功（dryRun=" + dryRun + "）：" + remote + " " + branch +
          (setUpstream ? "（-u 已建立上游跟踪）" : "") + (force ? "（--force-with-lease）" : ""),
      ]
    : [
        "推送失败（exit code " + r.exitCode + "）：" + remote + " " + branch + "",
      ];
  const rawOut = (r.stdout || "").trim();
  const rawErr = (r.stderr || "").trim();
  if (rawOut) text.push("—— stdout ——\n" + rawOut);
  if (rawErr) text.push("—— stderr ——\n" + rawErr);
  if (r.ok) {
    if (/Everything up-to-date/.test(rawOut + rawErr)) {
      text.push("远端已是最新（Everything up-to-date），无新提交需要推送。");
    } else if (/->/.test(rawOut + rawErr)) {
      text.push("远端引用已更新（见上方 -> 行）。");
    }
  } else {
    const s = rawOut + "\n" + rawErr;
    if (/not a git repository/i.test(s)) {
      text.push("提示：当前目录不是 git 仓库，请在仓库目录内执行。");
    } else if (/does not appear to be a git repository|repository .* not found/i.test(s)) {
      text.push("提示：远端 " + remote + " 不存在或不可达：请检查 remote 配置（git remote -v）或 URL。");
    } else if (/non-fast-forward|fetch first|rejected/i.test(s)) {
      text.push("提示：远端拒绝了快进推送（non-fast-forward）：先拉取合并远端变更，或用 git_push force=true（--force-with-lease）安全覆盖。");
    } else if (/Authentication failed|could not read Username|fatal: unable to access/i.test(s)) {
      text.push("提示：远端认证失败（https 凭据不可用）：请确认凭据（可走 gh keyring / git credential），或检查远端 URL 协议。");
    }
  }
  return text.join("\n");
}
