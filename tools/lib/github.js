/**
 * GitHub 域工具共享 helper（纯函数，可静态导入）。
 *
 * v1 REST 只读面（github_api / github_pr_comments / github_pr_files）已移除
 * （manifest 不再声明 network 白名单，GitHub 域操作统一走 gh CLI）——本模块只保留
 * v2 CLI 面（gh-exec / gh-pr）共用的参数解析与校验纯函数。
 *
 * 职责：
 * - repo 参数解析与校验（仅显式 repo 参数，无默认无回落，不依赖工作目录推断）
 * - 数字参数运行时校验（正整数）
 */

/**
 * 解析并校验 repo 参数（格式 owner/repo，正好一个斜杠）。
 * 仅接受显式传入的 repo 参数：无默认仓库配置、无工作目录推断。
 * @param {unknown} repoParam 工具参数中的 repo 值（可能为 undefined/null）
 * @returns {{ owner: string, repo: string } | { error: string }}
 */
export function resolveRepo(repoParam) {
  const explicit =
    repoParam !== undefined && repoParam !== null ? String(repoParam).trim() : "";
  const raw = explicit;
  if (!raw) {
    return {
      error:
        "未指定仓库：Agent 需显式传入 repo（格式 owner/repo），本插件无默认仓库配置。",
    };
  }
  const parts = raw.split("/");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    return {
      error:
        'repo 参数格式非法："' +
        raw +
        '"。要求格式为 owner/repo（正好一个斜杠，如 liliMozi/openhanako）。',
    };
  }
  return { owner: parts[0].trim(), repo: parts[1].trim() };
}

/**
 * 数字参数运行时校验：必须为正整数（配合 parameters schema 的 integer/minimum 双保险）。
 * @returns {{ ok: true, value: number } | { error: string }}
 */
export function validatePositiveInt(value, label) {
  if (value === undefined || value === null || value === "") {
    return { error: label + " 不能为空。" };
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: label + " 必须是正整数（当前值：" + String(value) + "）。" };
  }
  return { ok: true, value: n };
}
