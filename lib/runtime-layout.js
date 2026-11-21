import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { hostFs as fs } from "./extract-asar.js";

// 打包运行时在 0.2.1/0.2.2 早期位于 resources/runtime，其下挂 primary-runtime。
export const PNPM_ENTRY = "primary-runtime/dependencies/pnpm/bin/pnpm.mjs";
// 0.2.2-rc.5 起桌面安装器把运行时搬到用户数据目录：
//   <DSH_HOME>/dsh-runtimes/<name>/dependencies/pnpm/bin/pnpm.mjs
// 此时 <name> 自己就是 primary runtime，没有 primary-runtime 这一层。
export const DIRECT_PNPM_ENTRY = "dependencies/pnpm/bin/pnpm.mjs";

const ENTRIES = [PNPM_ENTRY, path.join(process.arch, PNPM_ENTRY), DIRECT_PNPM_ENTRY];

function isFile(p) {
  try { return fs.statSync(p).isFile(); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * 找出 base 下的 pnpm 入口，并给出"该链接应指向哪个根"。
 * 架构嵌套布局要指向 <base>/<arch>，否则 app/runtime/primary-runtime 解析不到。
 * entry 相对 base（对外接口），rootEntry 相对 root（链接校验用）。
 */
function resolveRuntimeRoot(base) {
  if (!base || !fs.existsSync(base)) return null;
  for (const entry of ENTRIES) {
    if (!isFile(path.join(base, entry))) continue;
    const nested = entry === path.join(process.arch, PNPM_ENTRY);
    const root = nested ? path.join(base, process.arch) : base;
    const rootEntry = nested ? PNPM_ENTRY : entry;
    return { root, entry, rootEntry };
  }
  return null;
}

/** root 既可能是"容器"（含 primary-runtime/），也可能就是 primary runtime 本身。 */
export function findPnpmEntry(root) {
  return resolveRuntimeRoot(root)?.entry ?? null;
}

export function dshHomeDir() {
  const env = String(process.env.DSH_HOME || "").trim();
  return env || path.join(os.homedir(), ".dsh");
}

/** 用户数据目录下的运行时根，dsh-primary-runtime 优先，其余按名字排序保证结果稳定。 */
function defaultUserRuntimeRoots() {
  const base = path.join(dshHomeDir(), "dsh-runtimes");
  let names;
  try { names = fs.readdirSync(base); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
  return names
    .map((name) => path.join(base, name))
    .filter(isDir)
    .sort((a, b) => (path.basename(b) === "dsh-primary-runtime") - (path.basename(a) === "dsh-primary-runtime") || a.localeCompare(b));
}

let userRuntimeRoots = defaultUserRuntimeRoots;
/** 测试钩子：注入空实现即可让判定与这台机器上的真实运行时隔离。 */
export function setUserRuntimeRoots(resolver) {
  userRuntimeRoots = typeof resolver === "function" ? resolver : defaultUserRuntimeRoots;
}

/** Preserve broken links; never delete a runtime directory or its contents. */
export function ensureAppRuntimeLink(resources, platform = process.platform) {
  const app = path.join(resources, "app"), runtime = path.join(resources, "runtime");
  const link = path.join(app, "runtime");
  const appStat = fs.statSync(app, { throwIfNoEntry: false });
  if (!appStat?.isDirectory()) {
    return { ok: false, reason: "missing_app", error: `Unpacked app directory missing or invalid: ${app}` };
  }
  // 先在安装目录里找；rc.5 之后那里可能为空，再退到用户数据目录。
  let resolved = resolveRuntimeRoot(runtime), source = "install-runtime";
  if (!resolved) {
    for (const candidate of userRuntimeRoots()) {
      resolved = resolveRuntimeRoot(candidate);
      if (resolved) { source = "user-runtime"; break; }
    }
  }
  if (!resolved) {
    return {
      ok: false, reason: "missing_runtime",
      error: `Official pnpm entry missing under: ${runtime} (also checked ${path.join(dshHomeDir(), "dsh-runtimes")})`,
    };
  }
  const { root: target, rootEntry } = resolved;
  let previous;
  try { previous = fs.lstatSync(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous && !previous.isSymbolicLink()) {
    return findPnpmEntry(link)
      ? { ok: true, already: true, type: "directory" }
      : { ok: false, reason: "runtime_conflict", error: "Existing app/runtime is incomplete and was retained." };
  }
  const canonical = (file) => {
    const resolved = path.normalize(fs.realpathSync(file));
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const within = (root, file) => {
    const rel = path.relative(root, file);
    return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  };
  let migration = null;
  if (previous) {
    let previousTarget;
    try { previousTarget = canonical(link); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Only failure to resolve the old link proves it is dangling.
    }
    if (previousTarget !== undefined) {
      if (previousTarget === canonical(target)) return { ok: true, already: true, source };
      // 只迁移"我们自己建的容器链接"（指向 resources/runtime）。两类迁移：
      //  · 目标在 runtime 之内（架构子目录）—— 原语义，要校验包含关系；
      //  · 目标在 runtime 之外且已解析为运行时根（rc.5 用户目录）—— 同样校验包含关系。
      // 指向任何别处的活链接都不动。
      if (previousTarget === canonical(runtime) && target !== runtime) {
        if (!within(canonical(runtime), canonical(target)) && source !== "user-runtime") {
          return { ok: false, reason: "runtime_conflict", error: "Architecture runtime or loader resolves outside this installation; existing link retained." };
        }
        if (!within(canonical(target), canonical(path.join(target, rootEntry)))) {
          return { ok: false, reason: "runtime_conflict", error: "Architecture runtime or loader resolves outside this installation; existing link retained." };
        }
        migration = within(canonical(runtime), canonical(target)) ? "architecture_container" : "runtime_container";
      }
      // The old target may have a different layout. Never replace a live link
      // merely because it does not have the new target's relative entry path.
      if (!migration) return { ok: false, reason: "runtime_conflict", error: "A different existing app/runtime link was retained." };
    }
  }
  const backup = previous ? `${link}.dshpurge-link-${randomUUID()}.bak` : "";
  if (backup) {
    try { fs.renameSync(link, backup); }
    catch (error) {
      return { ok: false, reason: "backup_failed", error: String(error.message || error), code: error.code, originalRetained: true };
    }
  }
  try {
    // Windows junction targets resolve against cwd, not the link's parent.
    fs.symlinkSync(platform === "win32" ? path.resolve(target) : path.relative(app, target), link, platform === "win32" ? "junction" : "dir");
    if (canonical(link) !== canonical(target) || !findPnpmEntry(link)) throw Error("Runtime link verification failed.");
    return { ok: true, created: true, type: platform === "win32" ? "junction" : "dir", source, ...(backup ? { backup } : {}), ...(migration ? { migration } : {}) };
  } catch (error) {
    // Never recursively remove a link, especially a Windows junction. Move
    // any candidate aside before restoring the original link.
    let failedLink = "", rollbackError = "", restored = false;
    try {
      let candidate;
      try { candidate = fs.lstatSync(link); } catch (inspectError) { if (inspectError.code !== "ENOENT") throw inspectError; }
      if (candidate) {
        if (!candidate.isSymbolicLink()) throw Error("Unexpected runtime directory appeared; retained for manual recovery.");
        failedLink = `${link}.dshpurge-failed-${randomUUID()}.bak`;
        fs.renameSync(link, failedLink);
      }
      if (backup) { fs.renameSync(backup, link); restored = true; }
    } catch (restoreError) { rollbackError = String(restoreError.message || restoreError); }
    return {
      ok: false, reason: rollbackError ? "rollback_failed" : "link_repair_failed",
      error: String(error.message || error), code: error.code,
      ...(backup ? { backup, rollback: { ok: restored, ...(rollbackError ? { error: rollbackError } : {}) } } : {}),
      ...(failedLink ? { failedLink } : {}),
      ...(!backup && rollbackError ? { rollback: { ok: false, error: rollbackError } } : {}),
    };
  }
}

export function repairRuntimeForCli(cli) {
  const match = String(cli).replaceAll("\\", "/").match(/^(.*\/resources)\/app\/dsh\/node_modules\/@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js$/i);
  if (!match) return { ok: true, skipped: "not_unpacked_desktop" };
  return ensureAppRuntimeLink(match[1]);
}
