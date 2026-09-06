/**
 * gpg_keygen：为隔离环境初始化 git 身份 + 生成 GPG 密钥（GitHana 的隔离 gpg 工具，命名与文件名对齐）。
 *
 * 为什么是工具而不是脚本/Agent 手跑（对齐「密钥不进上下文」决策）：
 * 密钥生成、指纹提取、gitconfig 写入全在工具内部完成，Agent/对话只接触
 * 结果报告与公钥（公钥非敏感，需展示给用户上传 GitHub）。
 *
 * 行为（全部落在插件数据目录 dataDir，不读不污染用户 ~/.gitconfig / ~/.gnupg）：
 * 1. 提交者身份：邮箱经 token 自动推导（gh api user → noreply 邮箱 {id}+{login}@users.noreply.github.com），
 *    或本工具 email 参数显式覆盖；名字由 login/邮箱自动推导（…+ProjectNyaser@… → ProjectNyaser），
 *    可传 name 参数覆盖；身份写入隔离 gitconfig（<dataDir>/gitconfig，经 GIT_CONFIG_GLOBAL 生效）。
 *    推导失败（token 未配 / gh api 失败 / 解析失败）→ 中止并提示「配置 token 或传 email 参数」，
 *    不生成不删除不写身份。
 * 2. GPG 密钥：隔离落点为 <dataDir>/gnupg（下称 gpgDir）。keygen 侧所有 gpg 调用显式传
 *    --homedir <gpgDir>（双保险：vendor gnupg 亦认 --homedir）；git 签名侧（见 3）经
 *    gpg.program 指向插件 vendor gnupg（无 gpgconf.ctl → 非便携模式，认 GNUPGHOME env，
 *    git spawn 时继承 runCli 注入的 GNUPGHOME=<gpgDir>）命中隔离环。不做 gpgconf 探针
 *    （gpgconf 不支持 --homedir、恒报编译默认 home，无隔离参考价值）。隔离空间
 *    始终只保留一份活动 ed25519 签名密钥（UID name+email，无口令——Agent 无头
 *    签名；密钥仅存插件空间，可单独吊销）。首次执行 = 生成；重复执行 = 轮换：
 *    先清空隔离环旧密钥、再生成新密钥：旧密钥逐个删除（删除前复核其确实在隔离
 *    环内——环内均为插件自有历史密钥，用户个人主密钥在 scoop 个人环、不在此环，
 *    清理不涉个人资产；任一删除失败即中止，不清不建，部分已删可读提示、剩余保留，
 *    重跑可继续），全部删除成功后再生成（环已空 → UID 无冲突，无需后缀唯一化）；
 *    清理后若生成失败 = 隔离环空、当前无签名密钥；插件环空 = 无签名能力、可随时
 *    重跑重建，不涉任何个人资产。
 * 3. 签名接线：密钥指纹写入隔离 gitconfig（user.signingkey + commit.gpgsign=true）并写
 *    gpg.program=<resolveBin("gpg").cmd>。宿主内嵌 git（2.55 MinGit）不支持 gpg.homedir
 *    （本地 help --config 无此条目、实测 -c gpg.homedir 不生效），gpg.program 也不支持
 *    带参（整串当 argv0）——故 gpg.program 必须指向一个「认 GNUPGHOME env」的 gpg：
 *    vendor gnupg（无 gpgconf.ctl → 非便携模式）即满足，git spawn 它时继承 runCli 注入
 *    GNUPGHOME=<dataDir>/gnupg → 签名与验签命中隔离环（GIT_TERMINAL_PROMPT 由 runCli 注入）。
 *    系统 scoop gpg 在 bin 目录带 gpgconf.ctl（便携模式，homedir 恒为 scoop home，
 *    忽略 GNUPGHOME env），不可用于此接线。
 * 4. 返回报告 + 新公钥（armored）——首次使用把公钥贴到 GitHub（Settings →
 *    SSH and GPG keys → New GPG key）后，签名提交即 verified；轮换后旧公钥失效，
 *    需删除旧公钥并上传新公钥（本工具会提示）。
 *
 * email 语义：密钥 UID 邮箱必须等于提交作者邮箱（token 自动推导的 noreply 邮箱，
 * 或 email 参数显式值）才能被 GitHub 验证为 verified——生成密钥强制用该邮箱，不另设 gpgEmail。
 * 安全（删除前置复核）：轮换删除某指纹前，先用 gpg --homedir <gpgDir>
 * --with-colons --list-secret-keys <fpr> 复核该指纹确实存在于隔离环（exit 0 且输出
 * 含该 fpr）；不存在/失败 → 中止删除并返回可读错误（个人 scoop 环存有同指纹同
 * 私钥副本，删除落到个人环即误删——复核兜底此风险）。
 * 收尾清理：所有 gpg 操作（生成/删除/接线/导出）后统一经 execute 的 finally 调用
 * gpgconf --kill gpg-agent scdaemon（见 killGpgDaemons）——gpg-agent 被 gpg 自动拉起后
 * 默认常驻不退出（为缓存口令，无空闲退出计时），还会按需拉起同环 scdaemon；无头签名
 * 场景每次用完必须显式清理，防插件环残留 daemon 进程。
 * 权限：plugin_output（只写插件自有 dataDir，无外部副作用）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  deriveNameFromEmail,
  deriveNameFromLogin,
  noreplyEmailFromUser,
} from "./lib/identity.js";
import { runCli } from "./lib/exec.js";
import { resolveBin } from "./lib/bin.js";
import {
  initToolContext,
  getToolDataDir,
  getToolConfigValue,
} from "./lib/context.js";

export const name = "gpg_keygen";

export const description = [
  "初始化插件的隔离 git/GPG 环境（密钥生成全在工具内部，不进对话）：",
  "1) 提交者邮箱经 token 自动推导（gh api user → GitHub noreply 邮箱 {id}+{login}@users.noreply.github.com），",
  "或显式 email 参数覆盖；名字由 login/邮箱自动推导，可用 name 参数覆盖；身份写入隔离 git 配置",
  "（插件数据目录 gitconfig，不读不污染 ~/.gitconfig；推导失败会中止并提示「配置 token 或传 email 参数」）；",
  "2) 在隔离 gpg 环（<dataDir>/gnupg）生成 ed25519 GPG 签名密钥（UID 邮箱 = 推导/指定的提交作者邮箱，需匹配才能 verified）——keygen 侧 gpg 调用显式 --homedir，签名侧经 gpg.program 指向插件 vendor gnupg（认 GNUPGHOME env），双重隔离；",
  "首次执行 = 生成，重复执行 = 轮换：先清空隔离环旧密钥（逐个删除前置复核，环内均为插件自有密钥，用户个人主密钥不在本环，清理不涉个人资产）、再生成新密钥；删除失败即中止（不清不建），清理后生成失败 = 环空可重跑重建（不涉个人资产）；UID 无需唯一化（环空生成无冲突）；",
  "3) 密钥指纹写入隔离 gitconfig（user.signingkey + commit.gpgsign=true + gpg.program=<vendor gnupg 绝对路径>），宿主 git spawn vendor gpg 继承 runCli 注入的 GNUPGHOME → 签名与验签命中隔离环，此后 git_commit 自动签名；",
  "4) 返回报告 + 公钥（armored）。公钥自动落盘为 <dataDir>/github-toolkit-gpg-pubkey.asc（固定名，轮换后覆盖为最新），报告给出文件路径；",
  "请把公钥贴到 GitHub（Settings → SSH and GPG keys → New GPG key），",
  "之后插件签名提交即显示 verified。轮换后需删除 GitHub 上的旧公钥并上传新公钥，签名才重新 verified。",
].join(" ");

export const sessionPermission = { kind: "plugin_output" };

export const parameters = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "可选：提交者名字（覆盖 login/邮箱自动推导值；用于 git 身份与 GPG UID）。默认从 token 推导的 login（61904116+ProjectNyaser@... → ProjectNyaser）或 noreply 邮箱自动得出，无需配置",
    },
    email: {
      type: "string",
      description:
        "可选：提交者邮箱（显式覆盖 token 自动推导的 noreply 邮箱；必须 = 提交作者邮箱，GPG UID 与 verified 依赖它）",
    },
  },
};

/**
 * GPG 私钥完整指纹解析（--list-secret-keys --with-colons）。
 * --with-colons 输出中，sec: 行第 5 字段（parts[4]）只是 keyid（受 --keyid-format LONG
 * 影响为 16 位短 id），完整 40 位指纹在紧随该 sec: 行之后的 fpr: 行第 10 字段
 * （parts[9]）——gpg --batch 删除要求按完整指纹指定密钥（16 位 keyid 在 batch 模式被拒：
 * "can't do this in batch mode (unless you specify the key by fingerprint)"），故必须解析
 * fpr: 行取完整指纹，不能取 sec 行的 keyid。
 * 用状态机遍历行：遇 sec: 行置 pending（进入某主钥块），紧随其后的 fpr: 行即该主钥的
 * 完整指纹（push parts[9]）；遇 ssb:（子钥块）或新的 sec: 重置 pending——ssb 子钥之后
 * 也有自己的 fpr: 行（子钥指纹），不得误收为独立密钥。
 * 返回完整指纹数组——轮换删除旧密钥需要列出隔离空间所有已有密钥，不能只取第一把。
 */
function parseSecretFingerprints(stdout) {
  const fps = [];
  let pending = false;
  for (const line of String(stdout).split("\n")) {
    if (line.startsWith("sec:")) {
      pending = true; // 进入主钥块：紧随其后的 fpr: 行是该主钥的完整指纹
      continue;
    }
    if (line.startsWith("ssb:")) {
      pending = false; // 子钥块：其后 fpr: 行是子钥指纹，重置避免误收
      continue;
    }
    if (pending && line.startsWith("fpr:")) {
      const parts = line.split(":");
      if (parts[9]) fps.push(parts[9]);
      pending = false; // 已取该主钥完整指纹；剩余块内行不再关联
    }
  }
  return fps;
}

/** 取第一把 secret 密钥指纹（无密钥 → null；生成后读新指纹的单指纹场景） */
function parseSecretFingerprint(stdout) {
  const fps = parseSecretFingerprints(stdout);
  return fps.length ? fps[0] : null;
}

/** 列出隔离空间全部 secret 密钥完整指纹（显式 --homedir gpgDir 锁定隔离环；list 失败按无密钥处理，返回 []）。
 *  注：fpr: 行的完整指纹不受 --keyid-format 影响（其只改 sec 行 keyid 的显示位宽），故不传 --keyid-format LONG，调用更干净。 */
async function listSecretFingerprints(gpgDir) {
  const r = await runCli(
    "gpg",
    ["--homedir", gpgDir, "--batch", "--list-secret-keys", "--with-colons"],
    {}
  );
  return r.ok ? parseSecretFingerprints(r.stdout) : [];
}

/**
 * 轮换清理单个旧密钥。删除前置复核：先用 gpg --homedir <gpgDir> --with-colons
 * --list-secret-keys <fpr> 复核该 fpr 确实存在于隔离环（exit 0 且输出含该 fpr）；
 * 不存在/失败 → 中止删除并返回可读错误——隔离落点异常时删除会落到用户个人 scoop
 * 环（个人环存有同指纹同私钥副本，等同误删），故一律拒绝。复核通过后
 * gpg --homedir <gpgDir> --batch --yes --delete-secret-and-public-key 成对删除
 * secret+public；删除成功后同时移除该旧指纹的撤销证书
 * <gnupg>/openpgp-revocs.d/<fpr>.rev（若存在），保持隔离空间干净。
 * @returns {{ ok: boolean, message?: string }}
 */
async function deleteOldKeyPair(fpr, gpgDir) {
  const check = await runCli(
    "gpg",
    ["--homedir", gpgDir, "--with-colons", "--list-secret-keys", fpr],
    {}
  );
  if (!check.ok || !String(check.stdout || "").includes(fpr)) {
    return {
      ok: false,
      message:
        "fpr " + fpr + " 不在隔离环（" + gpgDir + "）内，拒绝删除——隔离落点可能异常，" +
        "未执行任何删除。请用 gpg --homedir " + gpgDir + " --list-secret-keys 核对后手动处理。",
    };
  }
  const del = await runCli(
    "gpg",
    ["--homedir", gpgDir, "--batch", "--yes", "--delete-secret-and-public-key", fpr],
    {}
  );
  if (!del.ok) {
    return { ok: false, message: del.message || "未知错误" };
  }
  const revPath = path.join(gpgDir, "openpgp-revocs.d", fpr + ".rev");
  if (fs.existsSync(revPath)) {
    try {
      fs.rmSync(revPath, { force: true });
    } catch {
      /* 撤销证书删除尽力而为，不影响主流程 */
    }
  }
  return { ok: true };
}

/**
 * 收尾清理：杀掉插件环的 gpg-agent / scdaemon 常驻进程（防进程残留）。
 * 背景：keygen 侧 gpg 操作（quick-generate-key / 删除 / --export 等）经 gpg-agent 执行——
 * agent 被 gpg 自动拉起后默认常驻不退出（为缓存口令，无空闲退出计时），还会按需拉起
 * 同环 scdaemon（--multi-server --homedir 插件环）；无头签名场景每次用完必须显式清理，
 * 否则残留 <vendor>/gnupg/bin/gpg-agent.exe --homedir <插件环> --daemon + scdaemon.exe。
 * 清理机制：gpgconf --kill gpg-agent scdaemon 可杀指定 homedir 的 daemon——gpgconf 不支持
 * --homedir 参数、靠 GNUPGHOME env 定位；runCli（exec.js applyPluginIsolation）已注入
 * GNUPGHOME=<dataDir>/gnupg，且 gpgconf 走插件 vendor/gnupg（bin.js candidatesFor 已纳入：
 * 无 gpgconf.ctl → 认 env；系统 scoop gpgconf 带 gpgconf.ctl 不认 env、杀不到插件环）→
 * 本调用精准命中插件环 daemon，不影响用户个人 scoop home 的 gpg/agent。
 * 幂等无副作用：失败/无 daemon 均静默；清理失败不覆盖主结果（execute 的 finally 收尾，
 * 任何返回路径都不会被清理结果打断——runCli 本身不抛，此处仍兜底 catch）。
 */
async function killGpgDaemons() {
  if (!getToolDataDir()) return; // dataDir 未登记 → runCli 未注入 GNUPGHOME → 不 kill（避免误碰默认环）
  // vendor gnupg 缺失时 gpgconf 落系统 scoop（gpgconf.ctl 不认 env）：kill 无法命中插件环、
  // 可能误碰个人 scoop 环 → 跳过（插件无 vendor = 本无签名能力，无需清理）
  if (resolveBin("gpgconf").source !== "bundled") return;
  try {
    await runCli("gpgconf", ["--kill", "gpg-agent", "scdaemon"], {});
  } catch {
    /* 清理尽力而为：失败静默，不覆盖主结果 */
  }
}

export async function execute(input, ctx) {
  await initToolContext(ctx);
  // 执行主体包 try/finally：所有返回路径（含提前 return 的错误分支）统一先经 finally
  // 收尾清理插件环 gpg-agent/scdaemon（防 daemon 残留；机制见 killGpgDaemons 注释）。
  try {
    return await runKeygen(input);
  } finally {
    await killGpgDaemons();
  }
}

/**
 * 主体实现（身份解析 → gitconfig 写入 → GPG 生成/轮换 → 签名接线 → 公钥导出）。
 * 各分支直接 return 报告文本；收尾清理由 execute 的 finally 统一兜底，本函数不再关心。
 */
async function runKeygen(input) {
  const dataDir = getToolDataDir();
  if (!dataDir) {
    return "gpg_keygen：无法定位插件数据目录（ctx.dataDir 缺失），无法初始化隔离配置。";
  }
  fs.mkdirSync(dataDir, { recursive: true });

  const lines = [];
  const cfgPath = path.join(dataDir, "gitconfig");
  const gpgDir = path.join(dataDir, "gnupg");
  // 隔离环目录必须先建：全新 dataDir（重建/首装）下 gnupg/ 不存在，gpg --homedir 无法
  // 创建 pubring.kbx 与 spawn sentinel lock（实测报 "can't create ... sentinel.lock: 系统找不到指定的路径"）。
  fs.mkdirSync(gpgDir, { recursive: true });

  // —— 0. 提交者身份解析（email/name）——
  // 顺序：显式 email 参数 > token 自动推导（gh api user → noreply 邮箱）；推导失败
  // （token 未配 / gh api 失败 / 解析失败）→ 中止并报错区分原因，不生成不删除不写身份。
  const explicitEmail = String((input && input.email) || "").trim();
  const explicitName = String((input && input.name) || "").trim();
  let email = "";
  let name = "";
  if (explicitEmail) {
    // a. 显式 email 参数 → 直接使用；name = name 参数或 deriveNameFromEmail(email) 兜底
    email = explicitEmail;
    name = explicitName || deriveNameFromEmail(email);
  } else {
    // b. 否则 token 自动推导：gh api user（GH_TOKEN 由 exec.js 注入）→ {id, login}
    //    email = noreplyEmailFromUser(id, login)，name = name 参数或 deriveNameFromLogin(login)
    const token = String(getToolConfigValue("token") || "").trim();
    if (!token) {
      return (
        "gpg_keygen：未配置 GitHub token（插件设置）。提交者邮箱依赖 token 自动推导" +
        "（gh api user → noreply 邮箱 {id}+{login}@users.noreply.github.com）。\n" +
        "请配置 token 后重跑，或直接传 email 参数以跳过自动推导。本次未生成/删除任何密钥、未写身份。"
      );
    }
    const userR = await runCli("gh", ["api", "user"], {});
    if (!userR.ok) {
      return (
        "gpg_keygen：token 自动推导提交者身份失败——gh api user 调用失败：" +
        (userR.message || "未知错误") + "\n" +
        "请确认 token 有效（可访问 api.github.com；任意已认证 token 即可，无额外 scope），" +
        "或直接传 email 参数。本次未生成/删除任何密钥、未写身份。"
      );
    }
    let user = null;
    try {
      user = JSON.parse(userR.stdout);
    } catch {
      /* 解析失败走下方统一错误 */
    }
    const id = user && user.id;
    const login = user && user.login ? String(user.login).trim() : "";
    if (id === undefined || id === null || id === "" || !login) {
      return (
        "gpg_keygen：token 自动推导提交者身份失败——gh api user 响应解析失败" +
        "（未取得 {id, login}；原始输出前 200 字符：" + String(userR.stdout || "").slice(0, 200) + "）。\n" +
        "请检查 token 与网络后重试，或直接传 email 参数。本次未生成/删除任何密钥、未写身份。"
      );
    }
    email = noreplyEmailFromUser(id, login);
    name = explicitName || deriveNameFromLogin(login);
  }

  // —— 1. git 身份写入隔离 gitconfig ——
  {
    const setEmail = await runCli("git", ["config", "--global", "user.email", email], {});
    let ok = setEmail.ok;
    if (name) {
      const setName = await runCli("git", ["config", "--global", "user.name", name], {});
      ok = ok && setName.ok;
    }
    if (ok) {
      lines.push("git 身份已写入隔离配置：" + (name ? name + " <" + email + ">" : "<仅邮箱> " + email));
      lines.push("  配置： " + cfgPath);
    } else {
      lines.push("git 身份写入失败：" + (setEmail.message || "未知错误"));
    }
  }

  // —— 2/3. GPG 密钥（隔离环 <dataDir>/gnupg：keygen 侧 gpg 调用显式 --homedir gpgDir；
  //        git 签名侧另经 gpg.program → vendor gnupg 认 GNUPGHOME env，见下方接线） ——
  let fp = null;

  // 无邮箱保护：身份解析失败已在上方中止返回，走到这里必有 email（无邮箱不删不生成）。
  // 不做 gpgconf 探针（gpgconf 不支持 --homedir、恒报编译默认 home，无隔离参考价值）：
  // 隔离由 keygen 侧显式 --homedir 保证，轮换删除另有 fpr 前置复核（deleteOldKeyPair）兜底。
  const existingFps = await listSecretFingerprints(gpgDir);

  if (existingFps.length === 0) {
    // —— 路径 A：首次生成（隔离空间尚无密钥） ——
    const uid = (name || email.split("@")[0] || "Agent") + " <" + email + ">";
    lines.push("首次生成：隔离空间尚无 GPG 密钥，生成 ed25519 签名密钥（--homedir " + gpgDir + "，UID=" + uid + "）…");
    const genR = await runCli(
      "gpg",
      ["--homedir", gpgDir, "--batch", "--passphrase", "", "--quick-generate-key", uid, "ed25519", "sign", "0"],
      { timeoutSec: 120 }
    );
    if (!genR.ok) {
      lines.push("GPG 密钥生成失败（未产生密钥，无删除操作）：" + (genR.message || "未知错误") + "\n" + genR.stderr);
      return lines.join("\n");
    }
    const afterFps = await listSecretFingerprints(gpgDir);
    fp = afterFps.find((f) => !existingFps.includes(f)) || afterFps[0] || null;
    if (!fp) {
      lines.push("GPG 密钥生成后未能读取指纹，请检查隔离环（gpg --homedir " + gpgDir + " --list-secret-keys）");
    } else {
      lines.push("GPG 密钥已生成，指纹：" + fp);
      lines.push("  撤销证书： " + path.join(gpgDir, "openpgp-revocs.d", fp + ".rev") + "（建议备份）");
    }
  } else {
    // —— 路径 B：轮换替换（重复执行 = 轮换；先清后建：先逐个删除隔离环旧密钥，全部成功后再生成新密钥） ——
    // 背景：旧方案「先建后删」被 gpg 拒绝——quick-generate-key 不生成 UID 已存在的密钥，而待替换旧密钥
    // 的 UID 与新密钥目标 UID 必然相同（"A key for ... already exists"），先建永远无法完成，故改为先清后建。
    // 隔离环（<dataDir>/gnupg，--homedir 显式锁定）内全是插件自有历史密钥（实测 5A45413B… 与 B348CD…，
    // 均为插件历次生成产物），用户个人主密钥（9D23F08B…/BC798A01）在 scoop 个人环、不在插件环——清理
    // 插件环不涉个人资产。环清空后再生成，UID 无冲突，无需 UID 后缀 hack。
    lines.push("轮换替换：检测到 " + existingFps.length + " 把已有密钥，先逐个删除旧密钥（--homedir " + gpgDir + "），全部删除成功后再生成新密钥…");
    // 1) 先删：逐个删除全部旧密钥。deleteOldKeyPair 内部有删除前置复核（fpr 必须在隔离环内才删，
    //    个人 scoop 环物理不可达）；任一删除失败 → 中止不进入生成（不清不建），重跑可继续。
    const removed = [];
    let deleteFailed = false;
    for (const oldFp of existingFps) {
      const delR = await deleteOldKeyPair(oldFp, gpgDir);
      if (delR.ok) {
        removed.push(oldFp);
      } else {
        deleteFailed = true;
        lines.push("  删除失败：" + oldFp + "（" + (delR.message || "未知错误") + "）");
      }
    }
    if (deleteFailed) {
      // 不清不建：任一删除失败即中止、不进入生成。部分已删的可读提示，剩余的未动，重跑可继续。
      lines.push(
        "轮换中止：旧密钥删除失败（不清不建），未生成新密钥。" +
        (removed.length > 0
          ? "已删除 " + removed.length + " 把：" + removed.join(", ") + "；"
          : "未删除任何密钥；") +
        "剩余 " + (existingFps.length - removed.length) + " 把旧密钥原样保留，直接重跑本工具即可继续轮换。"
      );
      return lines.join("\n");
    }
    // 2) 后建：全部旧密钥已删、环已空——复用首次生成（路径 A）同款 UID 构造与生成调用
    //    （环空 → 无 UID 冲突，gpg quick-generate-key 可正常生成）。
    const uid = (name || email.split("@")[0] || "Agent") + " <" + email + ">";
    lines.push("隔离环旧密钥已全部清除（" + removed.length + " 把），生成新 ed25519 签名密钥（--homedir " + gpgDir + "，UID=" + uid + "）…");
    const genR = await runCli(
      "gpg",
      ["--homedir", gpgDir, "--batch", "--passphrase", "", "--quick-generate-key", uid, "ed25519", "sign", "0"],
      { timeoutSec: 120 }
    );
    if (!genR.ok) {
      // 清理后生成失败：环已空、当前无签名密钥。插件环空 = 无签名能力、可随时重建（不涉个人资产）——
      // 明确提示用户直接重跑本工具即可重新生成。
      lines.push(
        "轮换中止：隔离环已清空、新密钥生成失败（" + (genR.message || "未知错误") + "），当前无签名密钥。\n" +
        genR.stderr + "\n" +
        "插件隔离环为空 = 无签名能力、可随时重建（不涉任何个人资产）：直接重跑本工具即可重新生成。"
      );
      return lines.join("\n");
    }
    const afterFps = await listSecretFingerprints(gpgDir);
    fp = afterFps[0] || null;
    if (!fp) {
      lines.push("GPG 密钥生成后未能读取指纹，请检查隔离环（gpg --homedir " + gpgDir + " --list-secret-keys）");
    } else {
      lines.push("GPG 密钥已生成，指纹：" + fp);
      lines.push("  撤销证书： " + path.join(gpgDir, "openpgp-revocs.d", fp + ".rev") + "（建议备份）");
      lines.push("旧密钥已替换：" + removed.join(", ") + " → " + fp + "；若旧公钥已贴 GitHub，请删除旧公钥并上传新公钥。");
    }
  }

  // 签名接线：指纹写入隔离 gitconfig
  if (fp) {
    const s1 = await runCli("git", ["config", "--global", "user.signingkey", fp], {});
    const s2 = await runCli("git", ["config", "--global", "commit.gpgsign", "true"], {});
    // gpg.program 接线：宿主内嵌 git（2.55 MinGit）不支持 gpg.homedir（本地 help --config
    // 无此条目、实测 -c gpg.homedir 不生效），且 gpg.program 不支持带参（整串当 argv0）→
    // gpg.program 只能指向「认 GNUPGHOME env」的 gpg：插件 vendor gnupg（无 gpgconf.ctl →
    // 非便携模式）即满足——git spawn vendor gpg 继承 runCli 注入的 GNUPGHOME=<gpgDir>
    // → 签名/验签命中隔离环（GIT_TERMINAL_PROMPT 由 runCli 注入）。scoop 系统 gpg 带
    // gpgconf.ctl（便携模式恒指个人环、忽略 GNUPGHOME），不可用于此接线。
    const gpgProgram = resolveBin("gpg").cmd; // vendor gnupg 存在 = vendor 绝对路径；无 vendor = "gpg.exe" 系统回退
    const s3 = await runCli("git", ["config", "--global", "gpg.program", gpgProgram], {});
    const wiringOk = s1.ok && s2.ok && s3.ok;
    lines.push(
      "签名已接线（user.signingkey + commit.gpgsign=true + gpg.program=" + gpgProgram +
      " → git spawn vendor gpg 经 GNUPGHOME（runCli 注入）命中隔离环）：此后 git_commit 自动签名，" +
      "签名与验签均落隔离环 <" + gpgDir + ">。" +
      (wiringOk ? "" : "（配置写入异常：" + ([s1.message, s2.message, s3.message].filter(Boolean).join("；") || "?") + "）")
    );
    const exportR = await runCli("gpg", ["--homedir", gpgDir, "--armor", "--export", fp], {});
    if (exportR.ok && exportR.stdout.trim()) {
      // 公钥自动落地为文件（固定名，始终指向当前活动密钥的公钥；轮换后覆盖为最新）：
      // 用户/Agent 直接拿文件路径复制或交付即可，无需从工具输出里手工捞公钥块。
      const pubPath = path.join(dataDir, "github-toolkit-gpg-pubkey.asc");
      try {
        fs.writeFileSync(pubPath, exportR.stdout.trim() + "\n", "utf8");
        lines.push("");
        lines.push("公钥已保存：" + pubPath);
        lines.push("请打开该文件复制全文，贴到 GitHub：Settings → SSH and GPG keys → New GPG key；");
        lines.push("或直接交付该文件。轮换后此文件自动更新为新密钥的公钥。");
      } catch (e) {
        lines.push("");
        lines.push("公钥写入文件失败（" + (e && e.message ? e.message : String(e)) + "），请在下方直接复制：");
        lines.push("—— 请把以下公钥贴到 GitHub：Settings → SSH and GPG keys → New GPG key ——");
        lines.push(exportR.stdout.trim());
        lines.push("—— 公钥结束 ——");
      }
    }
  }

  lines.push("");
  lines.push("初始化完成。已生成隔离 git 配置：git_exec/git_commit 均不读用户 ~/.gitconfig。");
  return lines.join("\n");
}
