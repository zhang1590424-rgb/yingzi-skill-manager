import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
const releaseDir = path.join(rootDir, "release");
const productName = "影子";
const artifactName = "yingzi";

const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
const baseVersion = tauriConfig.version;
const releaseVersion = process.env.RELEASE_VERSION ?? `${baseVersion}-test.1`;
const releaseArch =
  process.env.RELEASE_ARCH ?? (process.arch === "arm64" ? "arm64" : process.arch);

const bundleCandidates = [
  path.join(rootDir, "src-tauri", "target", "release", "bundle", "dmg"),
  path.join(
    rootDir,
    "src-tauri",
    "target",
    "aarch64-apple-darwin",
    "release",
    "bundle",
    "dmg",
  ),
  path.join(
    rootDir,
    "src-tauri",
    "target",
    "universal-apple-darwin",
    "release",
    "bundle",
    "dmg",
  ),
];

const dmgFiles = [];

for (const candidate of bundleCandidates) {
  try {
    const entries = await readdir(candidate, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".dmg")) {
        const fullPath = path.join(candidate, entry.name);
        const info = await stat(fullPath);
        dmgFiles.push({ path: fullPath, mtimeMs: info.mtimeMs });
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

if (dmgFiles.length === 0) {
  throw new Error("找不到 Tauri 生成的 DMG，请先运行 tauri build --bundles app,dmg。");
}

dmgFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

await mkdir(releaseDir, { recursive: true });

const dmgFileName = `${artifactName}_${releaseVersion}_${releaseArch}.dmg`;
const dmgDestination = path.join(releaseDir, dmgFileName);
await cp(dmgFiles[0].path, dmgDestination);

const installGuidePath = path.join(releaseDir, `${artifactName}_install_guide.md`);
await writeFile(
  installGuidePath,
  `# ${productName} ${releaseVersion} 测试版安装说明

## 下载

请在 GitHub Release 的 Assets 区域下载：

- \`${dmgFileName}\`

## 支持范围

- 当前测试包仅面向 Apple Silicon Mac。
- 当前测试包未做 Apple Developer ID 签名和 Apple notarization 公证。

## 安装

1. 双击打开 \`${dmgFileName}\`。
2. 把「${productName}」拖到 Applications。
3. 从 Applications 打开「${productName}」。

## 首次打开被 macOS 拦截

如果 macOS 提示无法验证开发者，请尝试以下方式：

1. 在 Applications 中右键点击「${productName}」。
2. 选择「打开」。
3. 再次确认「打开」。

如果仍然被拦截，请到「系统设置」→「隐私与安全性」中允许打开。

## 反馈

请反馈：

- macOS 版本。
- Mac 芯片类型。
- 是否能完成安装和启动。
- 技能导入、应用和收回是否正常。
`,
);

console.log(`GitHub Release DMG 已准备：${dmgDestination}`);
console.log(`安装说明已准备：${installGuidePath}`);
