/**
 * tools/lib/bin.js — git/gh/gpg/gpgconf 可执行文件解析（内嵌优先，系统 PATH 兜底）。
 *
 * 设计（rebuild spec §5.3/§7，v3 形态）：候选顺序 = 插件 vendor 绝对路径 → 系统 PATH 回退；
 * git 另保留宿主内嵌（Hana resources/git）作为 vendor 缺失时的中间回退（dev 冒烟友好）。
 *
 *   git：插件 vendor/git（MinGit，0.4.6+ 决策）→ 宿主内嵌（Hana 捆绑 Git，
 *        HANA_DESKTOP_RESOURCES_PATH 定位）→ 系统 PATH
 *   gh ：插件 vendor/gh → 系统 PATH
 *   gpg/gpgconf：插件 vendor/gnupg（原生版无 gpgconf.ctl → 认 GNUPGHOME env）→ 系统 PATH
 *        （系统 scoop gpg 带 gpgconf.ctl = 便携模式、恒指 scoop home、忽略 GNUPGHOME，
 *        不可用于隔离签名/daemon 清理接线——gpg.program 与 gpgconf --kill 必须命中
 *        vendor gnupg，见 rebuild spec §6.1/§7）
 *
 * 隔离注入（applyPluginIsolation，rebuild spec §5.2）：buildBinEnv 每次 spawn 注入
 * GIT_CONFIG_GLOBAL=<dataDir>/gitconfig、GNUPGHOME=<dataDir>/gnupg（git spawn vendor gpg
 * 时经此命中隔离环）、GIT_TERMINAL_PROMPT=0；token 已配置时注入 GH_TOKEN（gh CLI 认证 +
 * keygen 身份推导）。dataDir 未登记（未 initToolContext）时不注入隔离 env——避免误碰
 * 用户默认 ~/.gitconfig / ~/.gnupg。
 *
 * 二进制不入 git 仓库：scripts/fetch-vendor.mjs 下载 + sha256 校验后写入 vendor/，pack 随包分发。
 * 可观察性：resolveBin 返回 binLabel（内嵌 gh / 插件内嵌 MinGit 等），runCli 结果带 binSource/binLabel。
 *
 * 平台注记：vendor 为 win-x64 asset；宿主 resources/git 布局同 Git for Windows
 * （cmd/git.exe + mingw64/ + usr/）。多平台分发时扩展 vendor/<platform>/。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getToolDataDir, getToolConfigValue } from "./context.js";

/** 插件根目录（bin.js 位于 <root>/tools/lib/，上两级即根） */
export const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

/** 宿主注入的 resources 根环境变量（desktop 启动 server 时设置，探针实测） */
const HOST_RESOURCES_ENV = "HANA_DESKTOP_RESOURCES_PATH";

const isWindows = process.platform === "win32";

/** MinGit/Git for Windows 布局里需要前置进 PATH 的目录（相对 git 根） */
const GIT_EXTRA_PATH = ["cmd", "mingw64", "bin", "usr", "bin"];

/** 宿主捆绑 git（Hana resources/git，安装面强制存在） */
function hostGitPath() {
  const res = process.env[HOST_RESOURCES_ENV];
  if (!res) return null;
  try {
    const p = path.join(res, "git", "cmd", "git.exe");
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * git/gh 候选链（按序探测，返回第一个存在者）。
 * git：宿主内嵌 → 插件 vendor（可选自包含）→ 系统 PATH。
 * gh ：插件 vendor → 系统 PATH（宿主未捆绑 gh）。
 */
function candidatesFor(bin) {
  if (bin === "git") {
    return [
      { path: hostGitPath(), label: "宿主内嵌 git", root: null },
      {
        path: path.join(PLUGIN_ROOT, "vendor", "git", "cmd", "git.exe"),
        label: "插件内嵌 MinGit",
        root: path.join(PLUGIN_ROOT, "vendor", "git"),
      },
    ];
  }
  if (bin === "gh") {
    return [
      {
        path: path.join(PLUGIN_ROOT, "vendor", "gh", "bin", "gh.exe"),
        label: "内嵌 gh",
        root: path.join(PLUGIN_ROOT, "vendor", "gh"),
      },
    ];
  }
  if (bin === "gpg" || bin === "gpgconf") {
    // vendor/gnupg：从 scoop gnupg 复制 bin+lib 后删除 gpgconf.ctl 置备（无 gpgconf.ctl =
    // 非便携模式、认 GNUPGHOME env——隔离签名与 gpgconf --kill 的前提，见 rebuild spec §6.1/§7）。
    return [
      {
        path: path.join(PLUGIN_ROOT, "vendor", "gnupg", "bin", bin + ".exe"),
        label: "内嵌 gnupg " + bin,
        root: path.join(PLUGIN_ROOT, "vendor", "gnupg"),
      },
    ];
  }
  return []; // 其他 bin：原样走系统 PATH / 绝对路径
}

/**
 * 解析可执行文件：候选链（宿主/内嵌）优先，全缺回退系统 PATH。
 * @param {string} bin "git" | "gh"（其他值原样返回，走系统 PATH / 绝对路径）
 * @returns {{ cmd: string, source: "bundled"|"system", binLabel: string|null,
 *            extraPath?: string[], bundledMissing?: boolean }}
 */
export function resolveBin(bin) {
  const candidates = candidatesFor(bin);
  for (const c of candidates) {
    if (c.path && fs.existsSync(c.path)) {
      const root = c.root || path.dirname(path.dirname(c.path)); // git 根（host/vendor 通用推导）
      const extraPath =
        bin === "git" ? GIT_EXTRA_PATH.map((p) => path.join(root, p)) : [];
      return { cmd: c.path, source: "bundled", binLabel: c.label, extraPath, bundledRoot: root };
    }
  }
  return {
    cmd: isWindows ? bin + ".exe" : bin,
    source: "system",
    binLabel: null,
    bundledMissing: candidates.length > 0, // 提示：宿主/内嵌均缺失，已回退系统 PATH
  };
}

/**
 * 构造子进程 env：在继承 env 基础上注入 bundled 需要的 PATH（git 的 cmd/mingw64/usr）
 * + 插件隔离 env（applyPluginIsolation，rebuild spec §5.2/§6）：
 * - GIT_CONFIG_GLOBAL=<dataDir>/gitconfig：git 配置隔离（keygen 写入身份/签名配置；
 *   不读用户 ~/.gitconfig）；
 * - GNUPGHOME=<dataDir>/gnupg：gpg/agent 定位隔离环（keygen 侧 gpg 另显式 --homedir 双保险；
 *   git spawn vendor gpg（gpg.program）时继承此 env 命中隔离环签名/验签；gpgconf --kill 亦靠此定位）；
 * - GIT_TERMINAL_PROMPT=0：无头不弹交互式凭据/确认；
 * - token 已配置时注入 GH_TOKEN（gh CLI 认证 + gpg-keygen 的 gh api user 身份推导）。
 * dataDir 未登记（工具未经 initToolContext）时不注入隔离 env——防误碰用户默认环。
 * @param {*} baseEnv 继承的基础 env（process.env 副本）
 * @param {ReturnType<typeof resolveBin>} resolved resolveBin 结果（source=bundled 时生效）
 * @returns {*} 注入后的 env
 */
export function buildBinEnv(baseEnv, resolved) {
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  if (resolved.source === "bundled" && resolved.extraPath && resolved.extraPath.length > 0) {
    env.PATH =
      resolved.extraPath.join(path.delimiter) + path.delimiter + (env.PATH || "");
  }
  const dataDir = getToolDataDir();
  if (dataDir) {
    env.GIT_CONFIG_GLOBAL = path.join(dataDir, "gitconfig");
    env.GNUPGHOME = path.join(dataDir, "gnupg");
    const token = getToolConfigValue("token");
    if (token) env.GH_TOKEN = token;
  }
  return env;
}
