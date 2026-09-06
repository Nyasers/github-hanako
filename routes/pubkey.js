/**
 * routes/pubkey.js — GitHana pubkey 会话流卡页 route（v3，rebuild spec §8.4）。
 *
 * 机制：工具（gpg_pubkey）返回 details.card.route = "/pubkey?ts=…" → 宿主在会话流
 * iframe 渲染本 route（iframe URL 拼接宿主注入的 hana-css / hana-theme / hana-host-origin
 * 等 query）。本 route 读插件数据目录（dataDir）里的活动公钥 + 隔离 gitconfig，把数据
 * 注入 assets/pubkey-card/pubkey.card.html 模板后返回完整 HTML（快照模式，无 SSE/轮询）。
 *
 * 无外部网络：数据全在插件自有 dataDir，公钥非敏感（本来就公开上传）。
 * 空态：公钥文件不存在（尚未 gpg_keygen）→ 注入 { hasKey:false }，卡页渲染引导文案。
 *
 * route 挂在宿主 /api/plugins/<pluginId>/ 命名空间（相对路径 "/pubkey"），
 * 由 index.js pluginRoutes 组合注册。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 插件根目录（routes/ 上两级） */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 卡页模板（assets/pubkey-card/pubkey.card.html） */
const TEMPLATE_PATH = path.join(PLUGIN_ROOT, "assets", "pubkey-card", "pubkey.card.html");
/** 活动公钥文件名（gpg_keygen 落盘固定名，轮换覆盖为最新） */
const PUBKEY_FILE = "github-toolkit-gpg-pubkey.asc";

/**
 * 简单 gitconfig（INI 形）键值读取：section 如 [user]，key 如 signingkey；值去引号。读不到返回 ""。
 * （与 tools/gpg-pubkey.js 内同款逻辑——route 侧独立副本，避免跨层 import 私有函数。）
 */
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
      cur = secMatch[1].toLowerCase();
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

/** HTML 属性转义（query 值注入用） */
function escAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 组装卡页数据：读 dataDir 活动公钥 + 隔离 gitconfig（fingerprint/uid）。
 * 文件不存在/读失败 → { hasKey:false }（卡页渲染空态引导）。
 */
function collectCardData(dataDir) {
  if (!dataDir) return { hasKey: false };
  let pubkey = "";
  try {
    pubkey = fs.readFileSync(path.join(dataDir, PUBKEY_FILE), "utf8").trim();
  } catch {
    pubkey = "";
  }
  if (!pubkey) return { hasKey: false };

  const cfgPath = path.join(dataDir, "gitconfig");
  const fpr = readGitConfigValue(cfgPath, "user", "signingkey").trim();
  const name = readGitConfigValue(cfgPath, "user", "name").trim();
  const email = readGitConfigValue(cfgPath, "user", "email").trim();
  const data = { hasKey: true, pubkey: pubkey };
  if (fpr) data.fpr = fpr;
  if (name || email) data.uid = name ? (email ? name + " <" + email + ">" : name) : email;
  return data;
}

/** 渲染模板：注入数据 JSON（防 </script> 逃逸）+ 宿主主题 link + body 主题标记 */
function renderCard(template, data, { hcLink, theme }) {
  // __DATA__ 占位 → JSON（"<" 转义为 \u003c，杜绝 </script> 提前闭合）
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  let html = template.replace("__DATA__", dataJson);
  if (hcLink) html = html.replace("<style>", hcLink + "<style>");
  if (theme) html = html.replace("<body>", '<body data-hana-theme="' + escAttr(theme) + '">');
  return html;
}

export default function registerPubkeyRoutes(app, ctx) {
  const base = "/api/plugins/" + (ctx && ctx.pluginId ? ctx.pluginId : "github-hanako");

  // GET <base>/pubkey?ts=…：会话流卡页（details.card.route 指向的相对路径）
  app.get("/pubkey", (c) => {
    // 宿主加载 iframe 时附加的主题注入参数（dsh-hanako 同款）：hana-css = 主题 stylesheet URL
    const hc = String((c.req && c.req.query && c.req.query("hana-css")) || "");
    const th = String((c.req && c.req.query && c.req.query("hana-theme")) || "inherit");
    const hcLink = hc ? '<link rel="stylesheet" href="' + escAttr(hc) + '">' : "";

    // dataDir：route ctx 由宿主注入（与工具 ctx 同源）。模板读盘失败按空态渲染兜底。
    let template = "";
    try {
      template = fs.readFileSync(TEMPLATE_PATH, "utf8");
    } catch (e) {
      return c.html(
        "<!DOCTYPE html><html><body style=\"font-family:system-ui;padding:16px\">" +
        "GitHana 卡页模板缺失（" + escAttr(String(e && e.message || e)) + "）</body></html>"
      );
    }
    const data = collectCardData(ctx && ctx.dataDir);
    return c.html(renderCard(template, data, { hcLink: hcLink, theme: th }));
  });
}
