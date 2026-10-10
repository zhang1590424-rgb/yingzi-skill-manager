/**
 * Host half of the Yingzi (影子) panel bundle.
 *
 * Bridges the Harness page to the local Yingzi data on disk:
 *   ~/.skills-manager/skills       canonical skill library (one directory per skill)
 *   ~/.skills-manager/config.json  { baseDir, skillsRoot, ... }
 *   ~/.skills-manager/app.db       SQLite (targets / skill_tags / tag_meta) — read-only
 *   <target>/.agents/skills        per-target shadow roots (directory symlinks)
 *
 * The tag database is opened read-only by design: 影子.app stays the single
 * writer, so both surfaces always show the same facts.
 *
 * Exactly one HTTP route is registered on the Harness web server (loopback):
 *   POST /yingzi/api   { op, ...args } → JSON
 * guarded by a per-activation random token delivered to the page through the
 * `webserver/index-inject` event (window.__YINGZI_TOKEN__). Cross-origin
 * requests and requests without the token are rejected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** Host services this half requires; absent services keep the plugin inactive. */
export const inject = ["webServer"];

const SKILLS_RELATIVE = ".agents/skills";
const MAX_BODY_BYTES = 1 << 20;

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(message, httpStatus = 400) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* path & format helpers (mirroring 影子 src-tauri/src/storage.rs)      */
/* ------------------------------------------------------------------ */

function expandHome(p) {
  const value = String(p ?? "");
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 智能路径判断：路径已以 .agents/skills 结尾则原样使用，否则追加。 */
function computeSkillsPath(targetPath) {
  const trimmed = String(targetPath ?? "").replace(/\/+$/, "");
  if (trimmed.endsWith(".agents/skills")) return trimmed;
  return path.join(trimmed, SKILLS_RELATIVE);
}

/**
 * 与影子后端 stable_id 完全一致的实现：Rust `DefaultHasher::new()` 是
 * SipHash-1-3（k0=k1=0），`str::hash` 先写 UTF-8 字节再写 0xFF 终止字节。
 * 已用 rustc 编译参考实现对拍验证（含 CJK 路径），逐位一致。
 */
const M64 = (1n << 64n) - 1n;
const ROTL = (x, b) => ((x << b) | (x >> (64n - b))) & M64;
function sipRound(v) {
  v[0] = (v[0] + v[1]) & M64; v[1] = ROTL(v[1], 13n); v[1] ^= v[0]; v[0] = ROTL(v[0], 32n);
  v[2] = (v[2] + v[3]) & M64; v[3] = ROTL(v[3], 16n); v[3] ^= v[2];
  v[0] = (v[0] + v[3]) & M64; v[3] = ROTL(v[3], 21n); v[3] ^= v[0];
  v[2] = (v[2] + v[1]) & M64; v[1] = ROTL(v[1], 17n); v[1] ^= v[2]; v[2] = ROTL(v[2], 32n);
}
function siphash13(bytes) {
  const v = [0x736f6d6570736575n, 0x646f72616e646f6dn, 0x6c7967656e657261n, 0x7465646279746573n];
  const len = bytes.length;
  let i = 0;
  while (i + 8 <= len) {
    let m = 0n;
    for (let k = 0; k < 8; k++) m |= BigInt(bytes[i + k]) << BigInt(8 * k);
    v[3] ^= m;
    sipRound(v);
    v[0] ^= m;
    i += 8;
  }
  let b = (BigInt(len) & 0xffn) << 56n;
  for (let k = i; k < len; k++) b |= BigInt(bytes[k]) << BigInt(8 * (k - i));
  v[3] ^= b;
  sipRound(v);
  v[0] ^= b;
  v[2] ^= 0xffn;
  sipRound(v);
  sipRound(v);
  sipRound(v);
  return (v[0] ^ v[1] ^ v[2] ^ v[3]) & M64;
}

function stableId(value) {
  const bytes = [...new TextEncoder().encode(String(value)), 0xff];
  return `id-${siphash13(bytes).toString(16)}`;
}

/** 与影子 slugify 一致：ASCII 字母数字、-、_ 小写保留；空白与 / \ : . 归为连字符；其余字符（含 CJK）原样保留。 */
export function slugify(value) {
  let slug = "";
  for (const ch of String(value).trim()) {
    const lower = ch.toLowerCase();
    if ((lower >= "a" && lower <= "z") || (lower >= "0" && lower <= "9") || lower === "-" || lower === "_") {
      slug += lower;
    } else if (/\s/.test(ch) || "/\\:.".includes(ch)) {
      if (!slug.endsWith("-")) slug += "-";
    } else {
      slug += ch;
    }
  }
  slug = slug.replace(/^-+|-+$/g, "");
  return slug === "" ? stableId(String(value)) : slug;
}

/** 与影子 remove_preview_noise 一致：剔除 telemetry 注释块后 trim。 */
function removePreviewNoise(value) {
  let text = String(value ?? "");
  const START = "<!-- @telemetry:start -->";
  const END = "<!-- @telemetry:end -->";
  for (;;) {
    const at = text.indexOf(START);
    if (at < 0) break;
    const rel = text.slice(at).indexOf(END);
    if (rel < 0) break;
    text = text.slice(0, at) + text.slice(at + rel + END.length);
  }
  return text.split(START).join("").split(END).join("").trim();
}

/** 与影子 compact_text 一致：全部空白折叠为单个空格。 */
function compactText(value) {
  return String(value ?? "").split(/\s+/).filter(Boolean).join(" ");
}

/** 与影子 first_meaningful_line 一致：跳过空行 / # 标题 / 水平线。 */
function firstMeaningfulLine(body) {
  const found = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#") && line !== "---");
  return found === undefined ? "" : compactText(found);
}

/** 与影子 split_frontmatter 一致：闭合栅栏按「整行 trim 后等于 ---」判定。 */
function stripFrontmatter(content) {
  const trimmed = String(content ?? "").replace(/^\uFEFF/, "").trimStart();
  const lines = trimmed.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return [null, trimmed.trim()];
  const frontmatter = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return [frontmatter.join("\n"), lines.slice(i + 1).join("\n").trim()];
    }
    frontmatter.push(lines[i]);
  }
  return [null, trimmed.trim()];
}

/** 与影子 clean_frontmatter_scalar 一致：trim → 去首尾双引号 → 去首尾单引号 → trim。 */
function cleanScalar(value) {
  return String(value ?? "").trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "").trim();
}

/** 与影子 parse_inline_tags 一致：[a, b] 或 a, b。 */
function parseInlineTags(value) {
  const cleaned = cleanScalar(value);
  const inner = cleaned.startsWith("[") && cleaned.endsWith("]") ? cleaned.slice(1, -1) : cleaned;
  return inner.split(",").map(cleanScalar).filter((tag) => tag !== "");
}

/** 与影子 parse_tag_lines 一致：tags: 块列表行（- 前缀）。 */
function parseTagLines(lines) {
  const tags = [];
  for (const line of lines) {
    const value = cleanScalar(line.trim().replace(/^-+/, "").trim());
    if (value !== "") tags.push(value);
  }
  return tags;
}

/**
 * SKILL.md 元数据解析——与影子 parse_skill_metadata 逐行镜像：
 * 顶层键判定（缩进行是块标量续行而非新键）、description/tags 多行收集、
 * compact_text 折叠、| / > 与空描述回退正文首行、「暂无描述」最终兜底。
 */
function parseSkillMetadata(dirName, content) {
  let displayName = String(dirName);
  let description = "";
  let tags = [];
  const [frontmatter, rawBody] = stripFrontmatter(content);
  const readableBody = removePreviewNoise(rawBody);
  if (frontmatter !== null) {
    let collecting = null;
    const descriptionLines = [];
    const tagLines = [];
    for (const rawLine of frontmatter.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (trimmed === "") {
        if (collecting === "description") descriptionLines.push("");
        continue;
      }
      const isTopLevel = !rawLine.startsWith(" ") && !rawLine.startsWith("\t");
      if (isTopLevel) {
        const colon = trimmed.indexOf(":");
        if (colon >= 0) {
          const key = trimmed.slice(0, colon).trim();
          const value = trimmed.slice(colon + 1).trim();
          collecting = null;
          if (key === "name") {
            const cleaned = cleanScalar(value);
            if (cleaned !== "") displayName = cleaned;
          } else if (key === "description") {
            if (value === "" || value.startsWith("|") || value.startsWith(">")) {
              collecting = "description";
              descriptionLines.length = 0;
            } else {
              description = cleanScalar(value);
            }
          } else if (key === "tags") {
            if (value === "") {
              collecting = "tags";
              tagLines.length = 0;
            } else {
              tags = parseInlineTags(value);
            }
          }
          continue;
        }
      }
      if (collecting === "description") descriptionLines.push(trimmed);
      else if (collecting === "tags") tagLines.push(trimmed);
    }
    if (description === "" && descriptionLines.length > 0) {
      description = compactText(descriptionLines.join(" "));
    }
    if (tags.length === 0 && tagLines.length > 0) {
      tags = parseTagLines(tagLines);
    }
  }
  if (description === "" || description === "|" || description === ">") {
    description = firstMeaningfulLine(readableBody) || "暂无描述";
  }
  return { displayName, description: compactText(description), tags, body: readableBody };
}

/* ------------------------------------------------------------------ */
/* filesystem diagnostics (mirroring analyze_target_path)              */
/* ------------------------------------------------------------------ */

function sameFsPath(a, b) {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * 目标位置诊断：enabled / disabled / conflict / broken / pathMissing / unreadable。
 * realpath 会穿过软链接，因此 realpath 相等即为本库影子。
 */
function analyzeTarget(dstPath, skillPath, rootExists) {
  if (!rootExists) {
    return { status: "pathMissing", linkTarget: null, issueCode: "pathMissingRoot", issueText: "目标技能目录不存在", rootExists: false };
  }
  let st;
  try {
    st = fs.lstatSync(dstPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { status: "disabled", linkTarget: null, issueCode: null, issueText: null, rootExists: true };
    }
    return { status: "unreadable", linkTarget: null, issueCode: "unreadable", issueText: "无法读取目标位置", rootExists: true };
  }
  if (st.isSymbolicLink()) {
    let linkTarget = null;
    try {
      const raw = fs.readlinkSync(dstPath);
      linkTarget = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(dstPath), raw);
    } catch {
      linkTarget = null;
    }
    if (sameFsPath(dstPath, skillPath)) {
      return { status: "enabled", linkTarget, issueCode: null, issueText: null, rootExists: true };
    }
    if (linkTarget !== null && !fs.existsSync(linkTarget)) {
      return { status: "broken", linkTarget, issueCode: "brokenLink", issueText: "软链接目标不存在", rootExists: true };
    }
    return { status: "conflict", linkTarget, issueCode: "symlinkForeign", issueText: "目标位置已有指向别处的软链接", rootExists: true };
  }
  return { status: "conflict", linkTarget: null, issueCode: "contentExists", issueText: "目标位置已有同名内容", rootExists: true };
}

/** 主库技能扫描：每个含 SKILL.md 的子目录是一个技能，目录名即 skill_id。 */
function scanLibrary(skillsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return { skills: [], issue: "技能主库不可读取" };
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(skillsRoot, entry.name);
    const mdPath = path.join(dir, "SKILL.md");
    let content;
    try {
      content = fs.readFileSync(mdPath, "utf8");
    } catch {
      continue;
    }
    const meta = parseSkillMetadata(entry.name, content);
    skills.push({
      id: entry.name,
      name: entry.name,
      displayName: meta.displayName,
      description: meta.description,
      path: dir,
      contentPreview: meta.body.trim().slice(0, 1200),
    });
  }
  skills.sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-Hans-CN"));
  return { skills, issue: null };
}

/* ------------------------------------------------------------------ */
/* store resolution & read-only database snapshot                      */
/* ------------------------------------------------------------------ */

function defaultGlobalTarget() {
  return { id: "agents", name: "全局", path: path.join(os.homedir(), ".agents", "skills"), isDefault: true };
}

function nodeSqlite() {
  try {
    return process.getBuiltinModule("node:sqlite") ?? null;
  } catch {
    return null;
  }
}

function resolveStore() {
  const home = os.homedir();
  const fallbackBase = path.join(home, ".skills-manager");
  const config = readJson(path.join(fallbackBase, "config.json")) ?? {};
  const baseDir = expandHome(config.baseDir || fallbackBase);
  const skillsRoot = expandHome(config.skillsRoot || path.join(baseDir, "skills"));
  const dbPath = path.join(baseDir, "app.db");
  return { baseDir, skillsRoot, dbPath };
}

/** 只读快照：targets + 标签。失败降级为默认全局目标 + 空标签，并把原因放进 issues。 */
function readDbSnapshot(dbPath, issues) {
  const fallback = { targets: [defaultGlobalTarget()], tagsBySkill: {}, tagMeta: [] };
  const sqlite = nodeSqlite();
  if (!sqlite) {
    issues.push("本机 Node 运行时缺少 node:sqlite，标签与目标列表降级为默认值");
    return fallback;
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    issues.push(`标签数据库只读打开失败，降级为默认目标：${messageOf(error)}`);
    return fallback;
  }
  try {
    const targets = [];
    for (const row of db.prepare("SELECT id, name, path, is_default AS isDefault FROM targets ORDER BY is_default DESC, name").all()) {
      targets.push({
        id: String(row.id),
        name: String(row.name),
        path: expandHome(String(row.path)),
        isDefault: Number(row.isDefault) !== 0,
      });
    }
    if (!targets.some((t) => t.isDefault)) targets.unshift(defaultGlobalTarget());
    const tagsBySkill = {};
    for (const row of db.prepare("SELECT skill_id AS skillId, tag FROM skill_tags").all()) {
      const id = String(row.skillId);
      (tagsBySkill[id] ??= []).push(String(row.tag));
    }
    const tagMeta = [];
    for (const row of db.prepare("SELECT tag, color_index AS colorIndex, sort_order AS sortOrder FROM tag_meta").all()) {
      tagMeta.push({ name: String(row.tag), colorIndex: Number(row.colorIndex), sortOrder: Number(row.sortOrder) });
    }
    tagMeta.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "zh-Hans-CN"));
    return { targets, tagsBySkill, tagMeta };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* state assembly                                                      */
/* ------------------------------------------------------------------ */

function buildState() {
  const { baseDir, skillsRoot, dbPath } = resolveStore();
  const issues = [];
  if (!fs.existsSync(skillsRoot)) issues.push(`技能主库不存在：${skillsRoot}`);
  const { skills, issue } = fs.existsSync(skillsRoot) ? scanLibrary(skillsRoot) : { skills: [], issue: null };
  if (issue) issues.push(issue);
  const { targets, tagsBySkill, tagMeta } = readDbSnapshot(dbPath, issues);

  const targetViews = targets.map((target) => {
    const skillsPath = computeSkillsPath(target.path);
    return {
      ...target,
      skillsPath,
      rootExists: fs.existsSync(skillsPath),
      pathExists: fs.existsSync(target.path),
    };
  });

  const targetStatuses = {};
  for (const target of targetViews) {
    const statuses = [];
    for (const skill of skills) {
      const dst = safeJoin(target.skillsPath, skill.id);
      const verdict = analyzeTarget(dst, skill.path, target.rootExists);
      statuses.push({
        id: `${target.id}-${skill.id}`,
        skillId: skill.id,
        skillName: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        targetId: target.id,
        targetName: target.name,
        status: verdict.status,
        targetPath: dst,
        linkTarget: verdict.linkTarget,
        issueCode: verdict.issueCode,
        issueText: verdict.issueText,
        rootExists: verdict.rootExists,
      });
    }
    targetStatuses[target.id] = statuses;
  }

  return {
    baseDir,
    skillsRoot,
    dbPath,
    skills: skills.map((s) => ({ ...s, tags: tagsBySkill[s.id] ?? [] })),
    targets: targetViews,
    targetStatuses,
    tagMeta,
    issues,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* operations: deploy / withdraw / import                              */
/* ------------------------------------------------------------------ */

function emptyReport() {
  return { changed: 0, skipped: 0, conflicts: [], errors: [], items: [] };
}

function pushReport(report, outcome, skillId, targetId, message) {
  if (outcome === "changed") report.changed += 1;
  else if (outcome === "skipped") report.skipped += 1;
  else if (outcome === "conflict") report.conflicts.push(message);
  else report.errors.push(message);
  report.items.push({ skillId, targetId, outcome, message });
}

function assertSegment(segment, label) {
  const value = String(segment ?? "");
  if (value === "" || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new ApiError(`非法的${label}：${value}`);
  }
  return value;
}

function safeJoin(base, segment) {
  const resolved = path.resolve(base, segment);
  const root = path.resolve(base);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ApiError(`路径越界：${segment}`);
  }
  return resolved;
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/** 判断 entryPath 是否为指向 expectedPath 的软链接（与影子 is_link_to 一致：词法解析，不要求存在）。 */
function isLinkTo(entryPath, expectedPath) {
  let raw;
  try {
    raw = fs.readlinkSync(entryPath);
  } catch {
    return false;
  }
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(entryPath), raw);
  return path.resolve(resolved) === path.resolve(expectedPath);
}

/* ------------------------------------------------------------------ */
/* writable database operations (tags / targets)                       */
/*                                                                     */
/* 影子.app 与本插件是仅有的两个写入方；写入用独立短事务 +              */
/* busy_timeout，与影子.app 并发打开互不阻塞。                          */
/* ------------------------------------------------------------------ */

function withWritableDb(fn) {
  const { dbPath } = resolveStore();
  const sqlite = nodeSqlite();
  if (!sqlite) throw new ApiError("本机 Node 运行时缺少 node:sqlite，无法写入配置数据库");
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath);
  } catch (error) {
    throw new ApiError(`配置数据库打开失败：${messageOf(error)}`);
  }
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn(db);
      db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* transaction already rolled back */
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

/** 导入时初始化技能标签（与影子 initialize_skill_tags 一致：settings 标记防复活）。 */
function initializeSkillTags(db, skillId, tags) {
  const key = `tag_initialized:${skillId}`;
  if (db.prepare("SELECT value FROM settings WHERE key = ?1").get(key) !== undefined) return;
  db.prepare("DELETE FROM skill_tags WHERE skill_id = ?1").run(skillId);
  const seen = new Set();
  const stmt = db.prepare("INSERT OR IGNORE INTO skill_tags (skill_id, tag) VALUES (?1, ?2)");
  for (const raw of tags) {
    const trimmed = String(raw ?? "").trim();
    if (trimmed !== "" && !seen.has(trimmed)) {
      seen.add(trimmed);
      stmt.run(skillId, trimmed);
    }
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')").run(key);
}

function opCreateTag(rawTag) {
  const tag = String(rawTag ?? "").trim();
  if (tag === "") throw new ApiError("标签名不能为空");
  withWritableDb((db) => {
    const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM tag_meta").get().m;
    db.prepare("INSERT OR IGNORE INTO tag_meta (tag, color_index, sort_order) VALUES (?1, -1, ?2)").run(tag, Number(maxOrder) + 1);
  });
  return { state: buildState() };
}

function opRenameTag(oldName, newName) {
  const from = String(oldName ?? "").trim();
  const to = String(newName ?? "").trim();
  if (to === "") throw new ApiError("标签名不能为空");
  if (from === to) return { state: buildState() };
  withWritableDb((db) => {
    if (Number(db.prepare("SELECT COUNT(*) AS c FROM tag_meta WHERE tag = ?1").get(to).c) > 0) {
      throw new ApiError(`标签已存在：${to}`);
    }
    db.prepare("UPDATE skill_tags SET tag = ?1 WHERE tag = ?2").run(to, from);
    db.prepare("DELETE FROM tag_meta WHERE tag = ?1").run(to);
    db.prepare("UPDATE tag_meta SET tag = ?1 WHERE tag = ?2").run(to, from);
  });
  return { state: buildState() };
}

function opSetTagColor(tag, colorIndex) {
  const name = String(tag ?? "").trim();
  const idx = Number(colorIndex);
  if (name === "" || !Number.isInteger(idx)) throw new ApiError("非法的标签颜色设置");
  withWritableDb((db) => {
    db.prepare("INSERT INTO tag_meta (tag, color_index) VALUES (?1, ?2) ON CONFLICT(tag) DO UPDATE SET color_index = excluded.color_index").run(name, idx);
  });
  return { state: buildState() };
}

function opDeleteTag(tag) {
  const name = String(tag ?? "").trim();
  if (name === "") throw new ApiError("标签名不能为空");
  withWritableDb((db) => {
    db.prepare("DELETE FROM skill_tags WHERE tag = ?1").run(name);
    db.prepare("DELETE FROM tag_meta WHERE tag = ?1").run(name);
  });
  return { state: buildState() };
}

function opReorderTags(tags) {
  const list = Array.isArray(tags) ? tags.map((tag) => String(tag ?? "").trim()).filter((tag) => tag !== "") : [];
  withWritableDb((db) => {
    const stmt = db.prepare("INSERT INTO tag_meta (tag, color_index, sort_order) VALUES (?1, -1, ?2) ON CONFLICT(tag) DO UPDATE SET sort_order = ?2");
    list.forEach((tag, index) => stmt.run(tag, index));
  });
  return { state: buildState() };
}

function opAddTarget(rawPath) {
  const source = String(rawPath ?? "").trim();
  if (source === "") throw new ApiError("目标路径不能为空");
  let target;
  try {
    target = fs.realpathSync(expandHome(source));
  } catch {
    throw new ApiError(`无法读取目标路径 ${source}`);
  }
  if (!fs.statSync(target).isDirectory()) throw new ApiError(`目标不是目录：${target}`);
  const name = path.basename(target) || "未命名目标";
  withWritableDb((db) => {
    db.prepare("INSERT OR REPLACE INTO targets (id, name, path, is_default) VALUES (?1, ?2, ?3, 0)").run(stableId(target), name, target);
  });
  return { state: buildState() };
}

function opRemoveTarget(targetId) {
  const id = String(targetId ?? "").trim();
  const { skillsRoot } = resolveStore();
  withWritableDb((db) => {
    if (id === "agents") throw new ApiError("默认全局目录不能移除");
    const row = db.prepare("SELECT path, is_default FROM targets WHERE id = ?1").get(id);
    if (row === undefined) throw new ApiError(`未找到目标：${id}`);
    if (Number(row.is_default) === 1) throw new ApiError("默认目标不能移除");
    const skillsPath = computeSkillsPath(String(row.path));
    let entryNames = [];
    try {
      entryNames = fs.readdirSync(skillsPath);
    } catch {
      /* 目录不存在视为无受管链接 */
    }
    let managed = 0;
    for (const entryName of entryNames) {
      if (isLinkTo(path.join(skillsPath, entryName), path.join(skillsRoot, entryName))) managed += 1;
    }
    if (managed > 0) throw new ApiError(`该目标下仍有 ${managed} 个受管技能，请先收回后再移除`);
    const changed = db.prepare("DELETE FROM targets WHERE id = ?1").run(id);
    if (Number(changed.changes) === 0) throw new ApiError(`未找到目标：${id}`);
  });
  return { state: buildState() };
}

/** 应用一个技能到一个目标：建立/替换目录软链接，永不触碰主库。 */
function deployOne(state, skillId, targetId, overwrite) {
  const skill = state.skills.find((s) => s.id === skillId);
  const target = state.targets.find((t) => t.id === targetId);
  if (!skill) throw new ApiError(`主库中不存在技能：${skillId}`);
  if (!target) throw new ApiError(`目标不存在：${targetId}`);
  const dst = safeJoin(target.skillsPath, skillId);
  const verdict = analyzeTarget(dst, skill.path, target.rootExists);

  if (verdict.status === "enabled" && !overwrite) {
    return { outcome: "skipped", message: "已是影子" };
  }
  if (verdict.status === "conflict" || verdict.status === "unreadable") {
    if (!overwrite) {
      return { outcome: "conflict", message: `${dst}（${verdict.issueText}）` };
    }
    removePath(dst);
  } else if (verdict.status === "enabled" || verdict.status === "broken") {
    removePath(dst);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.symlinkSync(skill.path, dst, "dir");
  return { outcome: "changed", message: verdict.status === "enabled" ? "已覆盖重建影子" : "已建立影子" };
}

/** 收回：只移除确实指向本库的影子链接；冲突内容一律不动。 */
function withdrawOne(state, skillId, targetId) {
  const skill = state.skills.find((s) => s.id === skillId);
  const target = state.targets.find((t) => t.id === targetId);
  if (!skill) throw new ApiError(`主库中不存在技能：${skillId}`);
  if (!target) throw new ApiError(`目标不存在：${targetId}`);
  const dst = safeJoin(target.skillsPath, skillId);
  const verdict = analyzeTarget(dst, skill.path, target.rootExists);

  if (verdict.status === "enabled") {
    removePath(dst);
    return { outcome: "changed", message: "已收回影子" };
  }
  if (verdict.status === "broken") {
    const pointsAtLibrary = verdict.linkTarget !== null && path.resolve(verdict.linkTarget) === path.resolve(skill.path);
    if (pointsAtLibrary) {
      removePath(dst);
      return { outcome: "changed", message: "已移除失效影子" };
    }
    return { outcome: "error", message: `${dst}（${verdict.issueText}）` };
  }
  if (verdict.status === "disabled") {
    return { outcome: "skipped", message: "目标位置本就没有影子" };
  }
  return { outcome: "error", message: `${dst}（${verdict.issueText}）` };
}

/** 导入：把含 SKILL.md 的目录复制进主库；同名即报错，与影子 import_skill 语义一致。 */
function importOne(sourcePath) {
  const { skillsRoot } = resolveStore();
  const source = path.resolve(expandHome(String(sourcePath ?? "")));
  let st;
  try {
    st = fs.statSync(source);
  } catch {
    throw new ApiError(`目录不存在：${source}`);
  }
  if (!st.isDirectory()) throw new ApiError(`不是目录：${source}`);
  if (!fs.existsSync(path.join(source, "SKILL.md"))) {
    throw new ApiError("所选目录缺少 SKILL.md，不是可导入的技能");
  }
  const skillId = slugify(path.basename(source));
  const dst = safeJoin(skillsRoot, skillId);
  if (fs.existsSync(dst)) {
    throw new ApiError(`已存在同名技能：${skillId}`);
  }
  fs.cpSync(source, dst, { recursive: true, force: false, errorOnExist: true });

  // U16 对齐：标签库为权威，导入即按 SKILL.md frontmatter 初始化（空集合也写入防复活标记）。
  let tags = [];
  try {
    tags = parseSkillMetadata(skillId, fs.readFileSync(path.join(dst, "SKILL.md"), "utf8")).tags;
  } catch {
    tags = [];
  }
  withWritableDb((db) => initializeSkillTags(db, skillId, tags));

  return { skillId };
}

/** 用系统文件管理器打开目录（仅限主库路径或已注册目标路径）。 */
function revealPath(targetPath) {
  const state = buildState();
  const requested = path.resolve(expandHome(String(targetPath ?? "")));
  const allowed = [state.skillsRoot, ...state.targets.flatMap((t) => [t.path, t.skillsPath])];
  const inside = allowed.some((root) => {
    const r = path.resolve(root);
    return requested === r || requested.startsWith(r + path.sep);
  });
  if (!inside) throw new ApiError("仅允许打开主库或已注册目标内的目录");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(command, [requested], { detached: true, stdio: "ignore" });
  child.unref();
  return { ok: true };
}

function runBatch(state, skillIds, targetId, mode, overwrite) {
  const report = emptyReport();
  for (const raw of skillIds ?? []) {
    let skillId;
    try {
      skillId = assertSegment(raw, "技能 ID");
      const item = mode === "deploy"
        ? deployOne(state, skillId, targetId, overwrite)
        : withdrawOne(state, skillId, targetId);
      pushReport(report, item.outcome, skillId, targetId, item.message);
    } catch (error) {
      pushReport(report, "error", skillId ?? String(raw), targetId, messageOf(error));
    }
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* HTTP route                                                          */
/* ------------------------------------------------------------------ */

function json(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError("请求体过大", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function dispatch(op, args) {
  switch (op) {
    case "getState":
      return buildState();
    case "deploy":
      return runBatch(buildState(), [args.skillId], assertSegment(args.targetId, "目标 ID"), "deploy", args.overwrite === true);
    case "withdraw":
      return runBatch(buildState(), [args.skillId], assertSegment(args.targetId, "目标 ID"), "withdraw", false);
    case "deployBatch":
      return runBatch(buildState(), args.skillIds, assertSegment(args.targetId, "目标 ID"), "deploy", args.overwrite === true);
    case "withdrawBatch":
      return runBatch(buildState(), args.skillIds, assertSegment(args.targetId, "目标 ID"), "withdraw", false);
    case "importSkill": {
      const { skillId } = importOne(args.sourcePath);
      return { skillId, state: buildState() };
    }
    case "reveal":
      return revealPath(args.path);
    case "createTag":
      return opCreateTag(args.tag);
    case "renameTag":
      return opRenameTag(args.oldName, args.newName);
    case "setTagColor":
      return opSetTagColor(args.tag, args.colorIndex);
    case "deleteTag":
      return opDeleteTag(args.tag);
    case "reorderTags":
      return opReorderTags(args.tags);
    case "addTarget":
      return opAddTarget(args.path);
    case "removeTarget":
      return opRemoveTarget(args.targetId);
    default:
      throw new ApiError(`未知操作：${op}`);
  }
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const token = process.getBuiltinModule("node:crypto").randomUUID();

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/yingzi/api",
        handler: (req, res) => {
          void handle(req, res).catch((error) => {
            try {
              json(res, error instanceof ApiError ? error.httpStatus : 500, { error: messageOf(error) });
            } catch {
              /* response already gone */
            }
          });
        },
      }),
    "yingzi: api route",
  );

  const disposeInject = ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "global", name: "__YINGZI_TOKEN__", value: token });
  });

  async function handle(req, res) {
    if (req.method !== "POST") {
      json(res, 405, { error: "仅支持 POST" });
      return;
    }
    if (!sameOrigin(req)) {
      json(res, 403, { error: "已拒绝跨站请求" });
      return;
    }
    if (req.headers["x-yingzi-token"] !== token) {
      json(res, 403, { error: "缺少访问令牌，请刷新页面后重试" });
      return;
    }
    const raw = await readBody(req);
    let payload;
    try {
      payload = raw === "" ? {} : JSON.parse(raw);
    } catch {
      json(res, 400, { error: "请求体不是合法 JSON" });
      return;
    }
    try {
      json(res, 200, dispatch(String(payload?.op ?? ""), payload ?? {}));
    } catch (error) {
      json(res, error instanceof ApiError ? error.httpStatus : 400, { error: messageOf(error) });
    }
  }

  return () => disposeInject();
}
