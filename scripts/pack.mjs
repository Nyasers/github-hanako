// scripts/pack.mjs — github-hanako（GitHana）零依赖打包脚本
//
// 用法：node scripts/pack.mjs
// 产出：releases/github-hanako-v<version>.zip + .sha256（SHA256 大写）
//
// 设计：
// - 版本单一事实源：manifest.json 的 version（零 npm 依赖，不搞双版本源）
// - 无 build / 无 minify：纯 js 保持可读不压缩
// - 静态项复制到铺平目录 _tmp/pkg/<id>-v<version>/：
//   manifest.json、README.md、index.js（entry）、tools/（含 lib/）、routes/（卡页 route）、
//   assets/（卡页静态资源）——v3 形态：会话流路由卡（details.card），不再分发 recipes/
//   LICENSE + NOTICE：MPL-2.0（参照 dsh-hanako），随包分发
// - zip + SHA256：零第三方依赖，用 Node 内置 zlib.deflateRawSync 手写最小 ZIP 写入器
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import fs from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- 版本单一事实源：manifest.json ----
const manifest = JSON.parse(fs.readFileSync(join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;
if (!version) throw new Error("manifest.json version 缺失");
const pkgId = manifest.id || "github-toolkit";
const pkgDirName = pkgId + "-v" + version;

// ---- 交付清单：静态项直接复制（无 build / 无 minify） ----
// v3 形态：index.js（entry 注册卡路由）+ routes/ + assets/（pubkey 卡页）随包分发；
// 无 recipes/（v1 recipe 手动部署方案已废弃，rebuild spec §8.4）
const staticItems = ["manifest.json", "README.md", "LICENSE", "NOTICE", "index.js", "tools", "routes", "assets"];
// 内嵌运行时（vendor/，fetch-vendor.mjs 下载，不入库）：存在则随包分发（自包含安装包）
const vendorDir = join(ROOT, "vendor");
if (fs.existsSync(vendorDir)) {
  staticItems.push("vendor");
  console.log("[pack] vendor/ 随包分发（内嵌 git/gh/gnupg）");
} else {
  console.warn("[pack] 警告：vendor/ 不存在，安装包不含内嵌 git/gh/gnupg（先运行 node scripts/fetch-vendor.mjs 与 gnupg 置备）");
}

const flattenDir = join(ROOT, "_tmp", "pkg", pkgDirName);
fs.rmSync(flattenDir, { recursive: true, force: true });
fs.mkdirSync(flattenDir, { recursive: true });

for (const item of staticItems) {
  const src = join(ROOT, item);
  if (!fs.existsSync(src)) throw new Error("静态项不存在：" + item);
  fs.cpSync(src, join(flattenDir, item), { recursive: true });
  console.log("[pack] copy " + item);
}

// ---- 收集铺平目录文件（含目录项），供 zip 写入 ----
function collectFiles(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join("/");
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      out.push({ name: rel + "/", data: Buffer.alloc(0), mtime: st.mtime, isDir: true });
      out.push(...collectFiles(full, base));
    } else {
      out.push({ name: rel, data: fs.readFileSync(full), mtime: st.mtime, isDir: false });
    }
  }
  return out;
}
const pkgEntries = collectFiles(flattenDir);
// 顶层目录项（zip 内含 github-toolkit-v<version>/ 前缀，对齐 dsh-hanako 的 archive.directory）
// mtime 用 manifest.json 的 mtime（版本单一事实源，保证 zip 可复现——每次打包 SHA256 稳定）
const rootEntries = [{ name: pkgDirName + "/", data: Buffer.alloc(0), mtime: fs.statSync(join(ROOT, "manifest.json")).mtime, isDir: true }];
const entries = [
  ...rootEntries,
  ...pkgEntries.map((e) => ({
    ...e,
    name: pkgDirName + "/" + e.name,
  })),
];

// ---- 最小 ZIP 写入器（零依赖） ----
// CRC-32 表驱动实现（不依赖 zlib.crc32，兼容更早 Node）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** Date → DOS 日期时间（16bit 各一） */
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >>> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

function buildZip(fileList) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of fileList) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const isDir = f.isDir || f.name.endsWith("/");
    // 目录项用 store（method 0），文件用 deflate（method 8）
    const method = isDir ? 0 : 8;
    const comp = isDir ? Buffer.alloc(0) : deflateRawSync(f.data, { level: 9 });
    const crc = isDir ? 0 : crc32(f.data);
    const { time, date } = dosDateTime(f.mtime);

    // local file header（30 字节）
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // signature
    lh.writeUInt16LE(20, 4);           // version needed
    lh.writeUInt16LE(0x0800, 6);       // flags: UTF-8 filename
    lh.writeUInt16LE(method, 8);       // compression method
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // extra length
    chunks.push(lh, nameBuf, comp);

    // central directory entry（46 字节）
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // signature
    ch.writeUInt16LE(0x0314, 4);       // version made by: Unix, 2.0
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0x0800, 8);       // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);           // extra length
    ch.writeUInt16LE(0, 32);           // comment length
    ch.writeUInt16LE(0, 34);           // disk number start
    ch.writeUInt16LE(0, 36);           // internal attrs
    ch.writeUInt32LE(isDir ? 0o40755 : 0o100644, 38); // external attrs (Unix mode)
    ch.writeUInt32LE(offset, 42);      // local header offset
    central.push(ch, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const cdSize = central.reduce((s, b) => s + b.length, 0);
  // end of central directory（22 字节）
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);   // signature
  eocd.writeUInt16LE(0, 4);            // disk number
  eocd.writeUInt16LE(0, 6);            // cd start disk
  eocd.writeUInt16LE(fileList.length, 8);
  eocd.writeUInt16LE(fileList.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);           // comment length

  return Buffer.concat([...chunks, ...central, eocd]);
}

// ---- zip + SHA256（发布产物归档 releases/） ----
const relDir = join(ROOT, "releases");
fs.mkdirSync(relDir, { recursive: true });
const zipPath = join(relDir, pkgDirName + ".zip");
const zipBuf = buildZip(entries);
fs.writeFileSync(zipPath, zipBuf);

const sha = createHash("sha256").update(zipBuf).digest("hex").toUpperCase();
fs.writeFileSync(zipPath + ".sha256", sha, "utf8");

const sizeKB = (zipBuf.length / 1024).toFixed(1);
console.log("\n[pack] " + zipPath);
console.log("[pack] zip " + sizeKB + " KB · 文件数 " + entries.length + " · SHA256 " + sha);
console.log("[pack] sha256 文件：" + zipPath + ".sha256");
