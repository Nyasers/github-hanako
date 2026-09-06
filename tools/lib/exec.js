/**
 * tools/lib/exec.js — github-toolkit v2 子进程执行统一封装（git/gh CLI 唯一执行入口）。
 *
 * 设计（对齐 spec「Constraints」与「Design Decisions」）：
 * - spawn 异步执行：参数数组、无 shell（Windows/POSIX 一致，免转义免注入）；
 * - stdout / stderr 分通道捕获，各自截断到 MAX_OUTPUT_BYTES（200KB）防内存膨胀，
 *   截断时置 truncated 标记，展示层提示「输出过大已截断」；
 * - Windows CRLF 统一归一为 LF（各通道输出后续再处理）；
 * - 超时 kill：缺省 DEFAULT_TIMEOUT_SEC（120s），超时终止子进程返回可读错误（不挂起）；
 * - 退出码归一：返回 { ok: exitCode===0, exitCode, stdout, stderr, ... }；
 *   非零退出保留原始输出（stdout/stderr 原样返回），message 给可读诊断头；
 *   cwd 不存在/非目录、可执行文件不在 PATH（ENOENT）、启动失败等基础设施错误返回
 *   { ok:false, message }（中文可读，不抛裸异常——工具调用方直接展示 message 即可）。
 * - stdin 可选（input 字符串）：不传也立即关闭 stdin（EOF），非交互命令不挂起；
 *   一律注入 GIT_TERMINAL_PROMPT=0，杜绝 git/gh 子进程弹交互式凭据/确认。
 *
 * Windows 实现说明：git/gh 均为 PATH 中 .exe（spawn 经 PATH+PA THEXT 解析），
 * windowsHide 防弹窗；kill 超时进程用 child.kill()（TerminateProcess 单进程，
 * git 自身不常驻子进程；commit hook 等子进程由 git 自行收尾）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { resolveBin, buildBinEnv } from "./bin.js";

export const DEFAULT_TIMEOUT_SEC = 120;
/** 各输出通道截断上限（字节）：200KB */
export const MAX_OUTPUT_BYTES = 200 * 1024;

const CRLF = /\r\n?/g;

/** CRLF 归一 LF（同时兼容孤立 CR） */
export function normalizeNewlines(text) {
  return String(text ?? "").replace(CRLF, "\n");
}

/**
 * cwd 预校验：必须存在且为目录。cwd 为空/未传时返回 null（不强制——是否必填由各工具契约决定）；
 * 非法返回中文错误消息。
 * @param {unknown} cwd
 * @returns {string | null}
 */
export function checkCwd(cwd) {
  if (cwd === undefined || cwd === null) return null;
  const s = String(cwd).trim();
  if (!s) {
    return "cwd 不能为空：请传仓库的绝对路径（如 E:\\workspace\\my-repo）。";
  }
  let st;
  try {
    st = fs.statSync(s);
  } catch {
    return "cwd 不存在：" + s + "。请确认绝对路径正确（目录已被移动/删除？）。";
  }
  if (!st.isDirectory()) {
    return "cwd 不是目录：" + s + "。git/gh 命令需要在目录中执行，请传目录绝对路径。";
  }
  return null;
}

/**
 * 超时归一（秒）：非法/缺省回落 DEFAULT_TIMEOUT_SEC，下限 1 秒。
 * @returns {number}
 */
function normalizeTimeoutSec(timeoutSec) {
  if (timeoutSec === undefined || timeoutSec === null || timeoutSec === "") {
    return DEFAULT_TIMEOUT_SEC;
  }
  const n = Number(timeoutSec);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.max(1, Math.floor(n));
}

/** 可执行文件启动失败（ENOENT/EACCES/…）→ 中文可读 */
function spawnErrorMessage(bin, code, resolved) {
  if (code === "ENOENT") {
    const bundledHint =
      resolved && resolved.bundledMissing
        ? "（插件内嵌 vendor 缺失，已回退系统 PATH；可运行 scripts/fetch-vendor.mjs 下载内嵌 " + bin + "）"
        : "";
    return (
      "未找到可执行文件「" + bin + "」" + bundledHint + "：请确认 " + bin +
      " 已安装且所在目录在系统 PATH 中（Windows 下需能解析到 " + bin + ".exe，" +
      "如 C:\\Program Files\\Git\\cmd\\git.exe / " + bin + ".exe）。"
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return "执行「" + bin + "」权限不足（" + code + "）：请检查可执行文件与所在目录的权限。";
  }
  if (code === "ENOTDIR") {
    return "启动「" + bin + "」路径错误（ENOTDIR）：可执行文件路径段中存在非目录项，请检查 PATH 配置。";
  }
  return "启动进程失败（" + bin + "）" + (code ? "：" + code : "") + "，请重试或联系插件维护者。";
}

/** 非零退出的可读诊断头（取 stderr/stdout 尾部几行，完整原文在 stdout/stderr 字段里） */
function buildExitDiagnosis(bin, code, stdout, stderr) {
  const raw = (stderr && stderr.trim()) || (stdout && stdout.trim()) || "";
  const lines = [bin + " 命令执行失败（exit code " + code + "）。"];
  if (raw) {
    const tail = raw.split("\n").filter((l) => l.trim() !== "").slice(-6);
    if (tail.length) lines.push("诊断：" + tail.join("\n"));
  } else {
    lines.push("命令无任何输出。");
  }
  return lines.join("\n");
}

/**
 * runCli：spawn 异步执行单个 CLI（git/gh/…），返回归一化结果。
 *
 * @param {string} bin 可执行文件名（经 PATH 解析，如 "git" / "gh"）
 * @param {string[]} args 参数数组（无 shell 拼接）
 * @param {{ cwd?: string, timeoutSec?: number, input?: string }} [options]
 *   cwd 工作目录（绝对路径，可选但 git 工具必填）；timeoutSec 超时秒数（缺省 120）；
 *   input stdin 内容（多行/中文无损，git commit -F - 用）
 * @returns {Promise<{
 *   ok: boolean, exitCode: number | null,
 *   stdout: string, stderr: string,
 *   stdoutTruncated: boolean, stderrTruncated: boolean,
 *   timedOut: boolean, message: string | null
 * }>} ok=false 时 message 为中文可读错误；非零退出时 stdout/stderr 保留原始输出。
 */
export async function runCli(bin, args, { cwd, timeoutSec, input } = {}) {
  const cwdErr = checkCwd(cwd);
  if (cwdErr) {
    return {
      ok: false, exitCode: null, stdout: "", stderr: "",
      stdoutTruncated: false, stderrTruncated: false,
      timedOut: false, message: cwdErr,
    };
  }
  // 可执行文件解析：git/gh 走 bundled 优先（vendor/），缺失回退系统 PATH（见 bin.js）
  const resolved = resolveBin(bin);
  const argList = Array.isArray(args) ? args.map((a) => String(a)) : [];
  const sec = normalizeTimeoutSec(timeoutSec);

  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timedOutTriggered = false; // 超时 kill 已触发（区分信号终止与超时终止的文案）
    const stdoutCol = makeCollector(MAX_OUTPUT_BYTES);
    const stderrCol = makeCollector(MAX_OUTPUT_BYTES);
    let timer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      // 结果统一附带 bin 解析信息（可观察性：bundled 还是 system）
      resolve({
        ...value,
        binSource: resolved.source,
        binLabel: resolved.binLabel || null,
      });
    };

    try {
      child = spawn(resolved.cmd, argList, {
        cwd: cwd !== undefined && cwd !== null && String(cwd).trim() !== "" ? String(cwd).trim() : undefined,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: buildBinEnv(process.env, resolved),
      });
    } catch (err) {
      finish({
        ok: false, exitCode: null, stdout: "", stderr: "",
        stdoutTruncated: false, stderrTruncated: false,
        timedOut: false,
        message: spawnErrorMessage(bin, err && err.code, resolved),
      });
      return;
    }

    child.stdout.on("data", (d) => stdoutCol.push(d));
    child.stderr.on("data", (d) => stderrCol.push(d));

    child.on("error", (err) => {
      finish({
        ok: false, exitCode: null, stdout: normalizeNewlines(stdoutCol.text()),
        stderr: normalizeNewlines(stderrCol.text()),
        stdoutTruncated: stdoutCol.truncated(), stderrTruncated: stderrCol.truncated(),
        timedOut: false,
        message: spawnErrorMessage(bin, err && err.code, resolved),
      });
    });

    child.on("close", (code, signal) => {
      const stdout = normalizeNewlines(stdoutCol.text());
      const stderr = normalizeNewlines(stderrCol.text());
      // 被信号终止（超时 kill 或外部终止）
      if (code === null) {
        finish({
          ok: false, exitCode: null, stdout, stderr,
          stdoutTruncated: stdoutCol.truncated(), stderrTruncated: stderrCol.truncated(),
          timedOut: timedOutTriggered,
          message: timedOutTriggered
            ? bin + " 命令执行超时（" + sec + " 秒）：已终止进程。若属正常长任务，请增大 timeoutSec（git/gh 工具上限 600 秒）后重试。"
            : bin + " 命令被外部终止（signal" + (signal ? " " + signal : "") + "），已停止执行。",
        });
        return;
      }
      const ok = code === 0;
      finish({
        ok,
        exitCode: code,
        stdout,
        stderr,
        stdoutTruncated: stdoutCol.truncated(),
        stderrTruncated: stderrCol.truncated(),
        timedOut: false,
        message: ok ? null : buildExitDiagnosis(bin, code, stdout, stderr),
      });
    });

    // 超时 kill：先置标志，终止后由 close 事件收尾（code null → 可读超时消息）
    timer = setTimeout(() => {
      if (settled || !child) return;
      timedOutTriggered = true;
      try { child.kill(); } catch { /* 进程已退出 */ }
      // 若 kill 后 close 迟迟不来（极端），3 秒兜底直接结算超时错误
      const guard = setTimeout(() => {
        finish({
          ok: false, exitCode: null,
          stdout: normalizeNewlines(stdoutCol.text()),
          stderr: normalizeNewlines(stderrCol.text()),
          stdoutTruncated: stdoutCol.truncated(), stderrTruncated: stderrCol.truncated(),
          timedOut: true,
          message:
            bin + " 命令执行超时（" + sec + " 秒）：已终止进程。若属正常长任务，" +
            "请增大 timeoutSec（git/gh 工具上限 600 秒）后重试。",
        });
      }, 3000);
      guard.unref?.();
    }, sec * 1000);
    timer.unref?.();

    // stdin：input 有值则写入后关闭，否则立即关闭（EOF）——非交互不挂起
    try {
      if (input !== undefined && input !== null) {
        child.stdin.end(String(input));
      } else {
        child.stdin.end();
      }
    } catch {
      /* stdin 已关闭（进程快速退出），忽略 */
    }
  });
}

/**
 * 分通道有界收集器：超限即截断（保留开头，防单次巨块撑爆内存），内存上界 ≈ limit。
 */
function makeCollector(limit) {
  const parts = [];
  let size = 0;
  let truncated = false;
  return {
    truncated: () => truncated,
    push(buf) {
      if (truncated || size >= limit) return;
      const remaining = limit - size;
      if (buf.length > remaining) {
        parts.push(buf.subarray(0, remaining));
        size += remaining;
        truncated = true;
        return;
      }
      parts.push(buf);
      size += buf.length;
    },
    text() {
      return Buffer.concat(parts).toString("utf8");
    },
  };
}

/** 截断提示附注（渲染时用） */
function truncateNote(truncated, channel) {
  return truncated
    ? "（" + channel + " 输出过大，已截断保留开头部分，上限 " + Math.round(MAX_OUTPUT_BYTES / 1024) + "KB）"
    : "";
}

/**
 * 通用结果渲染：把 runCli 结果格式化为可读文本（git_exec/gh_exec 共用）。
 * - 成功：命令 + exit 0 + stdout/stderr（非空时）；
 * - 基础设施失败（message 且 exitCode null，如 cwd/bin/超时）：直接返回 message（附部分输出）；
 * - 非零退出：exit code + 命令 + stderr/stdout 原始输出（保留原文，附截断提示）。
 * @param {string} bin 展示名（git/gh）
 * @param {string[]} args
 * @param {*} result runCli 返回值
 * @returns {string}
 */
export function formatCliResult(bin, args, result) {
  const cmdLine = bin + (args.length ? " " + args.join(" ") : "");
  // 基础设施错误（cwd 不存在 / bin 未找到 / 超时等）：message 已可读
  if (!result.ok && result.exitCode === null && result.message) {
    let s = result.message;
    if (result.timedOut && (result.stdout || result.stderr)) {
      s += "\n—— 超时前已捕获的部分输出 ——\n" +
        blockIfAny("stdout", result.stdout) + blockIfAny("stderr", result.stderr);
    }
    return s;
  }

  const lines = [];
  if (result.ok) {
    lines.push(
      bin + " 命令执行成功（exit 0）" +
      (result.binLabel ? "（" + result.binLabel + "）" : "")
    );
  } else {
    lines.push(bin + " 命令执行失败（exit code " + result.exitCode + "）");
  }
  lines.push("命令：" + cmdLine);
  const outBlock = blockIfAny("stdout", result.stdout);
  if (outBlock) lines.push(outBlock + truncateNote(result.stdoutTruncated, "stdout"));
  const errBlock = blockIfAny("stderr", result.stderr);
  if (errBlock) lines.push(errBlock + truncateNote(result.stderrTruncated, "stderr"));
  if (!outBlock && !errBlock) lines.push("（无输出）");
  return lines.join("\n");
}

/** 非空通道 → 带标题块；空 → "" */
function blockIfAny(title, text) {
  if (!text) return "";
  return "—— " + title + " ——\n" + text;
}
