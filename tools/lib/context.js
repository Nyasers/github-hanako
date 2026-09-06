/**
 * tools/lib/context.js — 工具执行上下文单例（隔离配置底座 v0.4）。
 * 【重建版：按语义重写，非逐字恢复——结构与导出名照原实现】
 *
 * 背景（探针实测）：
 * - 工具 execute 的 ctx.config 是宿主「配置存储 API」对象（get/getAll/set，均 async），
 *   不是普通属性对象——直读 ctx.config.token 为 undefined（历史 v1 REST 工具因此从未真正
 *   读到设置页 token，config.json 兜底是唯一有效通道，属历史 bug，本模块修正）。
 * - ctx.dataDir 工具调用时注入；dev 槽带 dev 段（plugin-data/dev/<id>），正式安装为
 *   plugin-data/<id>。
 *
 * 用法：工具 execute 开头 `await initToolContext(ctx)` 一次（全量拉配置到单例），
 * lib/exec.js（runCli 隔离 env 组装）与各工具同步读单例，避免处处 async 化与重复 getAll。
 * 单例为进程级：同一插件实例内共享（插件单实例，dataDir/配置稳定，dsh 同款 getSingleton 模式）。
 */
let state = { dataDir: "", pluginDir: "", config: {} };

/**
 * 初始化上下文单例：拉取宿主配置全量 + 记录 dataDir/pluginDir。
 * 幂等，可重复调用（后调覆盖先调）。getAll 失败静默（保留已有 config）。
 */
export async function initToolContext(ctx) {
  if (ctx && ctx.dataDir !== undefined && ctx.dataDir !== null) {
    state.dataDir = String(ctx.dataDir);
  }
  if (ctx && ctx.pluginDir !== undefined && ctx.pluginDir !== null) {
    state.pluginDir = String(ctx.pluginDir);
  }
  try {
    if (ctx && ctx.config && typeof ctx.config.getAll === "function") {
      const all = await ctx.config.getAll();
      if (all && typeof all === "object" && !Array.isArray(all)) {
        state.config = all;
      }
    }
  } catch {
    /* getAll 失败保留已有配置（首次调用时为空对象，按未配置处理） */
  }
}

/** 当前插件数据目录（dev 槽带 dev 段；正式 = plugin-data/<id>）；未登记返回 "" */
export function getToolDataDir() {
  return state.dataDir;
}

/** 当前插件目录（工具代码所在）；未登记返回 "" */
export function getToolPluginDir() {
  return state.pluginDir;
}

/** 全量配置对象（getAll 结果；未配置为空对象） */
export function getToolConfig() {
  return state.config || {};
}

/**
 * 单键读配置：键不存在/值为空 → ""。
 * （双通道逻辑 caller 侧做：本函数只读宿主设置通道；config.json 兜底由调用方自行 readPluginConfig 类实现）
 */
export function getToolConfigValue(key) {
  const cfg = getToolConfig();
  const v = cfg[key];
  return v === undefined || v === null ? "" : String(v);
}
