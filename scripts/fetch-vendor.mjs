// scripts/fetch-vendor.mjs — github-toolkit 内嵌运行时下载脚本（零依赖）
//
// 背景：插件不依赖机器装好的 git/gh（对齐 dsh-hanako「用宿主 node」的自包含考量），
// 改为内联官方二进制（vendor/，见 tools/lib/bin.js）：
//   - vendor/git/  ← MinGit（Git for Windows 官方精简嵌入版，VS Code 同款）
//   - vendor/gh/   ← gh CLI 官方 release 单文件
// 二进制不入 git 仓库；安装/打包前跑本脚本补全 vendor/（sha256 校验，失败即拒绝）。
//
// 用法：
//   node scripts/fetch-vendor.mjs          # 全量（git + gh）
//   node scripts/fetch-vendor.mjs git      # 只补 git
//   node scripts/fetch-vendor.mjs gh       # 只补 gh
//   node scripts/fetch-vendor.mjs --check  # 只校验 vendor/ 现状（不下载）
//
// 升级版本：改下方 VERSIONS 表（version/sha256），下载缓存命中按 sha256 判定，
// 版本变了自然重新下载；升级后同步更新 README 的「内嵌运行时」注记。
//
// 平台注记：当前 VERSIONS 为 win-x64 asset；多平台分发时按平台扩展条目
// （asset 名带平台后缀，dest 落到 vendor/<platform>/，bin.js resolveBin 按 platform 选）。
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "_tmp", "vendor-dl"); // 下载缓存（_tmp 不入库，可随时清）

/**
 * 内嵌运行时清单：版本单一事实源。
 * sha256 取自各官方 release（git-for-windows / cli release 发布页）。
 */
const VERSIONS = {
  git: {
    label: "MinGit",
    version: "2.55.0.windows.1",
    asset: "MinGit-2.55.0-64-bit.zip",
    url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.1/MinGit-2.55.0-64-bit.zip",
    sha256: "31497e7968196332263459ee319d2524e3ebc5786ab895e2abad34ffdd4f4ebf",
    destDir: join(ROOT, "vendor", "git"),
    verifyExe: join(ROOT, "vendor", "git", "cmd", "git.exe"),
  },
  gh: {
    label: "gh CLI",
    version: "2.95.0",
    asset: "gh_2.95.0_windows_amd64.zip",
    url: "https://github.com/cli/cli/releases/download/v2.95.0/gh_2.95.0_windows_amd64.zip",
    sha256: "19a7154161ada9cfaa9e57edb752ecc679b75c391a62e4f7b586eea1df30b5bb",
    destDir: join(ROOT, "vendor", "gh"),
    verifyExe: join(ROOT, "vendor", "gh", "bin", "gh.exe"),
  },
};

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function log(...args) {
  console.log("[fetch-vendor]", ...args);
}

/** 单条目处理：缓存命中校验 → 下载+校验 → 解压到 destDir → exe 存在性验证 */
async function fetchOne(key, spec) {
  const cacheZip = join(CACHE_DIR, spec.asset);
  let zipReady = false;

  // 1) 下载缓存命中（同名且 sha256 一致）则跳过下载
  if (existsSync(cacheZip)) {
    try {
      if (sha256File(cacheZip) === spec.sha256) {
        log(spec.label, spec.version, "命中下载缓存", spec.asset);
        zipReady = true;
      } else {
        log(spec.label, "缓存校验不一致，重新下载", spec.asset);
        rmSync(cacheZip, { force: true });
      }
    } catch {
      rmSync(cacheZip, { force: true });
    }
  }

  // 2) 下载（Node 内置 fetch + 流式写盘 + 边下边算 sha256）
  if (!zipReady) {
    mkdirSync(CACHE_DIR, { recursive: true });
    log("下载", spec.label, spec.version, "→", spec.asset, "…");
    const res = await fetch(spec.url);
    if (!res.ok || !res.body) {
      throw new Error("下载失败（HTTP " + res.status + "）：" + spec.url);
    }
    const hash = createHash("sha256");
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(cacheZip);
      const reader = res.body.getReader();
      (function pump() {
        reader.read().then(({ done, value }) => {
          if (done) { ws.end(); resolve(); return; }
          hash.update(value);
          ws.write(value, (err) => (err ? reject(err) : pump()));
        }).catch(reject);
      })();
    });
    const got = hash.digest("hex");
    if (got !== spec.sha256) {
      rmSync(cacheZip, { force: true });
      throw new Error(
        "sha256 校验失败：" + spec.asset + "\n期望 " + spec.sha256 + "\n实际 " + got + "\n已删除，不落未校验二进制。"
      );
    }
    log("sha256 校验通过");
  }

  // 3) 解压到 destDir（Windows 自带 bsdtar 支持 zip；零第三方依赖）
  mkdirSync(spec.destDir, { recursive: true });
  log("解压 →", spec.destDir.replace(ROOT, "."));
  execFileSync("tar", ["-xf", cacheZip, "-C", spec.destDir], { stdio: "inherit" });

  // 4) exe 存在性验证
  if (!existsSync(spec.verifyExe)) {
    throw new Error("解压后未找到 " + spec.verifyExe.replace(ROOT, ".") + "，asset 结构可能变了");
  }
  log(spec.label, spec.version, "就绪：", spec.verifyExe.replace(ROOT, "."));
}

/** --check：只校验 vendor/ 现状（不下载不解压） */
function checkOnly() {
  let allOk = true;
  for (const [key, spec] of Object.entries(VERSIONS)) {
    if (existsSync(spec.verifyExe)) {
      log(spec.label, spec.version, "内嵌已就绪：", spec.verifyExe.replace(ROOT, "."));
    } else {
      allOk = false;
      log(spec.label, "缺失：", spec.verifyExe.replace(ROOT, "."), "（运行 node scripts/fetch-vendor.mjs " + key + " 补全）");
    }
  }
  process.exitCode = allOk ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check")) return checkOnly();
  const targets = args.filter((a) => !a.startsWith("-"));
  const keys = targets.length > 0 ? targets : Object.keys(VERSIONS);
  for (const key of keys) {
    if (!VERSIONS[key]) throw new Error("未知目标：" + key + "（可选：" + Object.keys(VERSIONS).join("/") + "）");
    await fetchOne(key, VERSIONS[key]);
  }
  log("完成。vendor/ 已就绪（.gitignore 忽略，不入库；打包由 pack 脚本随包分发）。");
}

main().catch((err) => {
  console.error("[fetch-vendor] 失败：", err.message || err);
  process.exit(1);
});
