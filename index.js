/**
 * index.js — github-hanako（GitHana）v3 entry：注册卡路由。
 *
 * v3 形态（rebuild spec §8.4）：full-access + entry 注册卡路由 + 工具返回 details.card
 * 触发会话流卡渲染（dsh-hanako 任务卡同款机制）。卡页 route 挂宿主
 * `/api/plugins/<pluginId>/` 命名空间下（相对路径注册，见 routes/pubkey.js）。
 *
 * 工具注册：manifest 无 contributes.tools —— 宿主自动扫描注册 tools/*.js，
 * 故本 entry 不重复 registerTool（dsh-hanako 单 bundle 形态才在 onload 里逐个注册）。
 * 无后台常驻逻辑：无需 activationEvents/onStartup 业务。
 */
import registerPubkeyRoutes from "./routes/pubkey.js";

/**
 * pluginRoutes：宿主挂载的具名导出——把所有卡页/页面路由挂到 app 上。
 * 宿主把 app 挂在 /api/plugins/<pluginId> 命名空间，这里注册相对路径。
 */
export const pluginRoutes = (app, ctx) => {
  registerPubkeyRoutes(app, ctx);
};

/**
 * 生命周期 default export class。GitHana 无常驻逻辑（路由经 pluginRoutes 挂载、
 * 工具由宿主扫描），onload 留空占位（宿主契约要求 entry default export class）。
 */
export default class GitHanaPlugin {
  async onload() {
    /* 无常驻逻辑：见文件头注记 */
  }
}
