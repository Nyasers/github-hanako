/**
 * tools/lib/identity.js — 提交者身份推导纯函数（v0.4 单键收敛）。
 * 【重建版：按语义重写，非逐字恢复——导出名与行为照原实现（gpg-keygen.js 调用点确认）】
 *
 * 身份来源：gh api user → { id, login }；GitHub noreply 邮箱格式 {id}+{login}@users.noreply.github.com。
 * 插件不配置邮箱/名字（拒绝多余配置键），keygen 时自动推导；keygen 的 email/name 参数可显式覆盖。
 */

/**
 * 由 GitHub 用户 {id, login} 推导 noreply 提交邮箱（GitHub 官方格式）。
 * @param {number|string} id 用户数字 id（gh api user → user.id）
 * @param {string} login 用户名（gh api user → user.login）
 * @returns {string} {id}+{login}@users.noreply.github.com
 */
export function noreplyEmailFromUser(id, login) {
  return String(id) + "+" + String(login) + "@users.noreply.github.com";
}

/**
 * 由 login 推导提交者名字：login 原样（如 ProjectNyaser）。
 * @param {string} login
 * @returns {string}
 */
export function deriveNameFromLogin(login) {
  return String(login || "").trim();
}

/**
 * 由邮箱推导提交者名字（显式 email 参数时兜底用）：
 * - noreply 邮箱（{id}+{login}@users.noreply.github.com）→ 取 + 与 @ 之间段（ProjectNyaser）；
 * - 普通邮箱 → 取 @ 前段；
 * - 解析不出返回 ""。
 * @param {string} email
 * @returns {string}
 */
export function deriveNameFromEmail(email) {
  const e = String(email || "").trim();
  if (!e) return "";
  const at = e.indexOf("@");
  if (at <= 0) return "";
  const local = e.slice(0, at);
  const plus = local.lastIndexOf("+");
  const cand = plus >= 0 ? local.slice(plus + 1) : local;
  return cand || "";
}
