import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appName = "影子.app";
const source = path.join(rootDir, "src-tauri", "target", "release", "bundle", "macos", appName);
const destination = path.join(rootDir, appName);

try {
  const sourceInfo = await stat(source);
  if (!sourceInfo.isDirectory()) {
    throw new Error(`打包产物不是目录：${source}`);
  }
} catch (error) {
  throw new Error(`找不到 Tauri 打包产物：${source}\n请先确认 tauri build 已成功完成。`, {
    cause: error,
  });
}

await rm(destination, { force: true, recursive: true });
await cp(source, destination, { recursive: true });

console.log(`桌面应用已同步到：${destination}`);
