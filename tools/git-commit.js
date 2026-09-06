/**
 * git_commit：提交工具（v2 场景写）——本地提交 + 自动 Co-authored-by 署名。
 *
 * 核心语义（对齐 spec）：
 * - message 用 stdin 传（git commit -F -），多行/中文无损；
 * - 自动 Co-authored-by trailer：固定写死（v0.3.1 对齐「直接写死」决策，移除配置键）——
 *   Co-authored-by: HanaAgent <313794804+HanaAgent@users.noreply.github.com>
 *   （@HanaAgent 为 liliMozi 注册的官方账号，仅作协作署名实体，不承担登录/认证；
 *   GitHub 据 email 把协作者归到 @HanaAgent）。
 *   在 message 尾部补空行后追加；message 已含 /^Co-authored-by:/mi 行则跳过（去重）。
 * - amend=true 且 message 为空：读 HEAD 完整 message（git log -1 --format=%B）作为基底，
 *   再按上述规则拼 trailer（既有 trailer 已含时自动去重，不重复追加）；
 * - 提交前检查：paths 缺省且无已暂存内容（git diff --cached --quiet 非零即无）→ 返回提示
 *   引导 git add 或传 paths，不空提交；allowEmpty=true 才允许空提交（--allow-empty）。
 * - paths：相对 cwd 的可选文件列表（缺省提交全部已 staged 内容；提供则只提交这些文件，
 *   文件未暂存也会按其工作区内容提交——git commit <paths> 语义）；与 amend 不能同用（git 限制）。
 * - 返回：短 hash + 首行 + 文件数统计（含署名是否追加的说明）。
 * 权限：external_side_effect（修改本地 git 历史；amend 改写最近提交）。
 */
import { runCli, checkCwd } from "./lib/exec.js";
import { resolveBin } from "./lib/bin.js";
import { initToolContext, getToolDataDir } from "./lib/context.js";

export const name = "git_commit";

export const description = [
  "在指定仓库创建本地提交，并自动追加 Co-authored-by 署名（title/body 之后空行 + ",
  "固定署名 Co-authored-by: HanaAgent <313794804+HanaAgent@users.noreply.github.com>（@HanaAgent 为 liliMozi 注册的官方账号，仅作协作署名实体，不承担登录/认证）；",
  "message 必填（经 stdin 传 git commit -F -，多行/中文无损）；",
  "paths 可选（相对 cwd 的文件列表，提交指定文件——未跟踪文件会自动先暂存（git add）后按路径提交，",
  "其余已暂存内容不受影响；缺省提交全部已暂存内容；无 paths 且无 staged 时返回提示，不会空提交，",
  "除非 allowEmpty=true）；amend 可选（改写最近提交，不需 staged，message 留空则沿用 HEAD 完整说明，",
  "已含 Co-authored-by 不重复追加）。cwd 必填（仓库绝对路径）。返回短 hash + 首行 + 文件数。",
  "注意：amend 会改写提交历史（force 推送需求请自评）；如需纯透传不带署名请用 git_exec。",
].join(" ");

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "git_local",
    summary:
      "在指定仓库（cwd）创建本地提交并自动追加 Co-authored-by 署名：修改本地 git 历史（生成新提交；amend 时改写最近一条提交），不推送远端；执行前请确认 cwd、message 与 paths",
    ruleId: "github-toolkit-git-commit",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    cwd: {
      type: "string",
      description: "git 仓库绝对路径（如 E:\\workspace\\my-repo），必填",
    },
    message: {
      type: "string",
      description: "提交说明（必填；amend 且需沿用原说明时可传空串）：支持多行（title 与 body 空行分隔）与中文，经 stdin 无损传入",
    },
    paths: {
      type: "array",
      items: { type: "string" },
      description: "可选：要提交的相对路径列表（相对 cwd，如 [\"src/a.js\"]）；缺省提交全部已暂存内容",
    },
    amend: {
      type: "boolean",
      description: "可选：改写最近一次提交（--amend）；message 为空时沿用 HEAD 完整 message 并自动合并署名（已含 Co-authored-by 不重复）",
    },
    allowEmpty: {
      type: "boolean",
      description: "可选：允许空提交（--allow-empty）；缺省 false——无 paths 且无已暂存内容时不空提交，返回引导提示",
    },
  },
  required: ["cwd", "message"],
};

/** 固定署名：@HanaAgent（liliMozi 注册的官方账号，仅作 Co-authored-by 协作署名实体，不承担登录/认证）。
 * name/email 写死（对齐「直接写死」决策），GitHub 据 email 把协作者归到 @HanaAgent。 */
const CO_AUTHOR_NAME = "HanaAgent";
const CO_AUTHOR_EMAIL = "313794804+HanaAgent@users.noreply.github.com";
/** 去重检测：消息任一行以 Co-authored-by: 开头（大小写不敏感、multiline） */
const CO_AUTHOR_LINE = /^Co-authored-by\s*:/im;

/** CRLF → LF（message 内部归一，避免 git 告警/不一致） */
function toLf(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

/** git 错误 → 中文引导（提交相关边界） */
function commitGuidance(stderr, stdout) {
  const s = String(stderr || "");
  if (/not a git repository|does not appear to be a git repository|not our repo/i.test(s)) {
    return "当前目录不是 git 仓库：请在仓库目录内执行（或先 git init）。";
  }
  if (/Please tell me who you are|unable to auto-detect email|user\.name|user\.email/i.test(s)) {
    return "git 未配置提交者身份：请先配置 git config user.name / user.email（可用 git_exec 配置）。";
  }
  if (/pathspec|does not match any|unable to resolve/i.test(s)) {
    return "路径不匹配：pathspec 未命中——文件可能不存在、不在仓库内或已被 .gitignore 忽略（git 原始输出见上）。";
  }
  return null;
}

/**
 * 组装最终 message：基底 + Co-authored-by 署名（固定写死）。
 * @returns {{ final: string, note: string }} note 说明署名动作（供返回展示/冒烟验证）
 */
function assembleMessage(base) {
  const body = toLf(base).replace(/\s+$/, "");
  if (CO_AUTHOR_LINE.test(body)) {
    return { final: body, note: "message 已含 Co-authored-by 行，自动署名跳过（去重生效）" };
  }
  const line = "Co-authored-by: " + CO_AUTHOR_NAME + " <" + CO_AUTHOR_EMAIL + ">";
  return { final: body + "\n\n" + line, note: "已自动追加署名：" + line };
}

/**
 * 收尾清理：杀掉插件环的 gpg-agent / scdaemon 常驻进程（rebuild spec §7，与 gpg-keygen 同款）。
 * 签名提交（隔离 gitconfig 的 commit.gpgsign=true + gpg.program=vendor gnupg）会拉起
 * 插件环 gpg-agent（默认常驻不退出，还会按需拉起同环 scdaemon）——收尾必须显式清理。
 * gpgconf 不支持 --homedir、靠 GNUPGHOME env 定位：runCli（buildBinEnv）已注入
 * GNUPGHOME=<dataDir>/gnupg，且 gpgconf 走插件 vendor/gnupg（无 gpgconf.ctl 认 env）→
 * 精准命中插件环，不碰用户个人 scoop home。
 * 幂等无副作用：失败/无 daemon 均静默（execute 的 finally 收尾，不覆盖主结果）。
 */
async function killGpgDaemons() {
  if (!getToolDataDir()) return; // dataDir 未登记 → 未注入 GNUPGHOME → 不 kill（防误碰默认环）
  if (resolveBin("gpgconf").source !== "bundled") return; // vendor 缺失 = 无签名能力；系统 gpgconf 不认 env
  try {
    await runCli("gpgconf", ["--kill", "gpg-agent", "scdaemon"], {});
  } catch {
    /* 清理尽力而为：失败静默，不覆盖主结果 */
  }
}

/**
 * 工具入口：先 initToolContext 登记 dataDir（runCli 据此注入 GIT_CONFIG_GLOBAL/GNUPGHOME
 * 隔离 env——签名配置来自隔离 gitconfig，缺登记则签名不生效），主体包 try/finally：
 * 任何返回路径统一经 finally 清理插件环 gpg-agent/scdaemon（防 daemon 残留）。
 */
export async function execute(input, ctx) {
  await initToolContext(ctx);
  try {
    return await runCommit(input);
  } finally {
    await killGpgDaemons();
  }
}

async function runCommit(input) {
  const cwdParam = input?.cwd;
  const cwdErr = checkCwd(cwdParam);
  if (cwdErr) return "git_commit 参数错误：" + cwdErr;
  const cwd = String(cwdParam).trim();

  const amend = input?.amend === true;
  const allowEmpty = input?.allowEmpty === true;
  const userMessage = toLf(input?.message ?? "").trimEnd();

  // paths：数组（允许空数组 = 未提供）
  let paths = [];
  if (input?.paths !== undefined && input?.paths !== null) {
    if (!Array.isArray(input.paths)) {
      return "git_commit 参数错误：paths 必须是字符串数组（相对 cwd 的路径）。";
    }
    for (const p of input.paths) {
      const s = String(p ?? "").trim();
      if (!s) return "git_commit 参数错误：paths 含空路径项。";
      if (/^([A-Za-z]:[\\/]|\/|\\\\)/.test(s)) {
        return "git_commit 参数错误：paths 项必须是相对路径（收到绝对路径：" + s + "），相对 cwd 传入。";
      }
      paths.push(s);
    }
  }

  if (!amend && !userMessage) {
    return "git_commit 参数错误：message 必填（非 amend 提交需要提交说明）；或改用 amend=true 沿用上一条提交说明。";
  }
  if (amend && paths.length > 0) {
    return "git_commit 参数错误：amend 不能与 paths 同用（git commit --amend 只按暂存区改写，不支持文件列表）。请去掉 paths 或去掉 amend。";
  }

  // 提交前检查：无 paths 且无已暂存内容 → 引导（allowEmpty / amend 除外——
  // amend 只改写最近提交的 message，不需要 staged 内容；allowEmpty 允许空提交）
  if (paths.length === 0 && !allowEmpty && !amend) {
    const stagedR = await runCli("git", ["diff", "--cached", "--quiet"], { cwd });
    if (!stagedR.ok) {
      const raw = (stagedR.stderr || "").trim();
      if (/not a git repository|does not appear to be a git repository/i.test(raw)) {
        return "git_commit：当前目录不是 git 仓库（git 提示：" + (raw.split("\n")[0] || raw) + "）。请在仓库目录内执行。";
      }
      // exit 1 = 有已暂存内容，正常继续；其他非零按错误透传
      if (stagedR.exitCode !== 1) {
        return "git_commit 预检失败（git diff --cached --quiet）：\n" + (stagedR.message || raw);
      }
    } else {
      // exit 0 = 无任何已暂存内容
      return [
        "git_commit：没有可提交的内容——既未传 paths 也没有已暂存（staged）的文件。",
        "请先 git add 目标文件（可用 git_exec）或传入 paths 指定要提交的相对路径；",
        "若确需创建空提交请显式传 allowEmpty=true。",
      ].join("\n");
    }
  }

  // 基底 message：amend 且用户未给说明 → 读 HEAD 完整 message（git log -1 --format=%B）
  let base = userMessage;
  if (amend && !base) {
    const headR = await runCli("git", ["log", "-1", "--format=%B"], { cwd });
    if (!headR.ok) {
      const raw = (headR.stderr || "").trim();
      if (/does not have any commits yet|bad default revision|ambiguous argument/i.test(raw)) {
        return "git_commit：amend 需要已有提交（HEAD 不存在：仓库尚无 commit，请用普通提交而非 amend）。";
      }
      if (/not a git repository/i.test(raw)) {
        return "git_commit：当前目录不是 git 仓库（git 提示：" + (raw.split("\n")[0] || raw) + "）。请在仓库目录内执行。";
      }
      return "git_commit 读取 HEAD message 失败（git log -1 --format=%B）：\n" + (headR.message || raw);
    }
    base = toLf(headR.stdout).trimEnd();
  }

  const assembled = assembleMessage(base);

  // paths 模式：先 git add -- <paths>（git commit <paths> 只能提交 git 已知路径——
  // 未跟踪文件必须先暂存；add 后仍按 pathspec 提交，其他已暂存内容不受影响、不会被带入本次提交）
  if (paths.length > 0) {
    const addR = await runCli("git", ["add", "--", ...paths], { cwd });
    if (!addR.ok) {
      const raw = ((addR.stderr || "") + "\n" + (addR.stdout || "")).trim();
      const guide = commitGuidance(addR.stderr, addR.stdout);
      const text = "git_commit 暂存 paths 失败（git add）：\n" + (raw || addR.message || "未知错误");
      return guide ? text + "\n" + guide : text;
    }
  }

  // git commit -F -（stdin 传 message，多行/中文无损）
  const args = ["commit", "-F", "-"];
  if (amend) args.push("--amend");
  if (allowEmpty) args.push("--allow-empty");
  if (paths.length > 0) args.push("--", ...paths);

  const commitR = await runCli("git", args, { cwd, input: assembled.final + "\n" });
  if (!commitR.ok) {
    const raw = ((commitR.stderr || "") + "\n" + (commitR.stdout || "")).trim();
    const guide = commitGuidance(commitR.stderr, commitR.stdout);
    const text =
      "git_commit 执行失败（exit code " + commitR.exitCode + "）：\n" +
      (raw || commitR.message || "未知错误");
    return guide ? text + "\n" + guide : text;
  }

  // —— 成功：取短 hash + 首行 + 文件数 ——
  const hashR = await runCli("git", ["rev-parse", "--short", "HEAD"], { cwd });
  const hash = hashR.ok ? hashR.stdout.trim() : "";
  const subjR = await runCli("git", ["log", "-1", "--format=%s"], { cwd });
  const subject = subjR.ok ? subjR.stdout.trim() : "";

  const filesR = await runCli("git", ["show", "--format=", "--name-only", "HEAD"], { cwd });
  const fileLines = filesR.ok
    ? filesR.stdout.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "")
    : [];
  const fileCount = allowEmpty && fileLines.length === 0 ? 0 : fileLines.length;

  const out = [
    "提交成功：" + (hash || "?") + (subject ? "  " + subject : ""),
    "文件数：" + fileCount + (fileLines.length ? "\n  " + fileLines.map((f) => "· " + f).join("\n  ") : ""),
    assembled.note,
  ];
  return out.join("\n");
}
