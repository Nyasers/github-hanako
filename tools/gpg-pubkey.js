/**
 * gpg_pubkey：读当前活动 GPG 签名公钥，返回 details.card 触发会话流渲染公钥复制卡（v3，rebuild spec §8.4）。
 *
 * 背景：gpg_keygen 每次生成/轮换后把新公钥落盘为 <dataDir>/github-toolkit-gpg-pubkey.asc
 * （固定名，恒为当前活动密钥）。本工具是给 Agent 的「出卡」入口——返回
 * details.card = { route: "/pubkey?ts=…", … } → 宿主在会话流 iframe 渲染插件自身卡页 route
 * （routes/pubkey.js 读 dataDir 公钥 + 隔离 gitconfig → 注入卡页模板返回完整 HTML；
 * 卡页显示指纹 + 折叠公钥全文 + 「复制公钥到剪贴板」（多层降级复制链，见卡页 JS））。
 * 公钥非敏感（本来就要公开上传），进入会话流/卡页无泄露风险；私钥永不触碰。
 *
 * 只读本插件数据目录（隔离 gitconfig + pubkey 文件），无任何外部副作用。
 * 权限：plugin_output（同 gpg_keygen 形——本工具只读插件自有 dataDir，无外部副作用）。
 */
import fs from "node:fs";
import path from "node:path";
import { initToolContext, getToolDataDir } from "./lib/context.js";

export const name = "gpg_pubkey";

export const description = [
  "读 GitHana（github-hanako）当前活动的 GPG 签名公钥，返回 details.card 在会话流渲染插件内置「公钥复制卡」（v3 路由卡，dsh-hanako 任务卡同款机制，无 recipe 无手动部署）：",
  "Agent 调用本工具（无参数）→ 返回 details.card = { route: '/pubkey?ts=…', title: '签名公钥', description, aspectRatio } → 宿主在会话流 iframe 渲染 /api/plugins/github-hanako/pubkey 卡页；",
  "卡页显示完整指纹 + 折叠公钥全文 + 「复制公钥到剪贴板」按钮（多层降级复制链：原生 Clipboard API → 宿主桥 → 选区复制，详见卡页 JS），并给 GitHub 上传分步指引（Settings → SSH and GPG keys → New GPG key）。",
  "本工具只做存在性确认与出卡触发，卡页数据由 route 读 dataDir 渲染（状态实时）；公钥文件不存在（尚未运行 gpg_keygen）时返回可读错误、不出卡，引导先运行 gpg_keygen。",
  "触发场景：用户上传/更新公钥到 GitHub（New GPG key）、复制当前公钥、轮换（gpg_keygen）后更新 GitHub 旧公钥、排查签名未 verified。",
].join(" ");

export const sessionPermission = { kind: "plugin_output" };

export const parameters = { type: "object", properties: {} };

/** 简单 gitconfig（INI 形）键值读取：section 如 [user]，key 如 signingkey；值去引号。读不到返回 "" */
function readGitConfigValue(cfgPath, section, key) {
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, "utf8");
  } catch {
    return "";
  }
  const wantSection = String(section || "").toLowerCase();
  const wantKey = String(key || "").toLowerCase();
  let cur = "";
  for (const rawLine of String(raw).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const secMatch = /^\[([^\]]+)\]$/.exec(line);
    if (secMatch) {
      cur = secMatch[1].toLowerCase(); // [user] 整段小写；[user "x"] 这类带引号段也取前段，匹配 user 段键不受影响
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim().toLowerCase();
    const v = line.slice(eq + 1).trim();
    if (cur === wantSection && k === wantKey) {
      const m = /^"(.*)"$/.exec(v);
      return m ? m[1] : v;
    }
  }
  return "";
}

export async function execute(input, ctx) {
  await initToolContext(ctx);
  const dataDir = getToolDataDir();
  if (!dataDir) {
    return "gpg_pubkey：无法定位插件数据目录（ctx.dataDir 缺失）。";
  }

  const pubPath = path.join(dataDir, "github-toolkit-gpg-pubkey.asc");
  let pubkey = "";
  try {
    pubkey = fs.readFileSync(pubPath, "utf8").trim();
  } catch {
    pubkey = "";
  }
  if (!pubkey) {
    return (
      "尚未生成密钥，先运行 gpg_keygen（未找到 " + pubPath + "）。\n" +
      "生成/轮换完成后再次调用本工具，即可铸造含真实公钥的复制卡。"
    );
  }

  // 指纹从隔离 gitconfig 读（gpg_keygen 写入 user.signingkey）——仅用于返回说明；
  // 卡页完整数据（指纹/uid/公钥）由卡页 route 读 dataDir 实时渲染，不在此重复携带。
  const cfgPath = path.join(dataDir, "gitconfig");
  const fpr = readGitConfigValue(cfgPath, "user", "signingkey").trim();

  // v3：返回 details.card → 宿主在会话流 iframe 渲染插件自身卡页 route（/pubkey）。
  // route 相对 /api/plugins/<pluginId>/ 命名空间（routes/pubkey.js 注册）；?ts= 防缓存。
  const human = "公钥已就绪" + (fpr ? "（fpr " + fpr + "）" : "") + "，正在会话流渲染公钥复制卡。";
  return {
    content: [{ type: "text", text: human }],
    details: {
      card: {
        route: "/pubkey?ts=" + Date.now(),
        title: "签名公钥",
        description: "GPG 签名公钥" + (fpr ? " · " + fpr.slice(0, 16) + "…" : "") + "：复制并上传 GitHub 验证签名",
        aspectRatio: "16:1",
      },
    },
  };
}
