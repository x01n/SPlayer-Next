/**
 * 把 USER_AGREEMENT.md 转换为 build/license.txt，给 NSIS 安装器作为协议页使用
 * 输出 UTF-8 + BOM + CRLF，确保中文与换行在 Windows 安装器里都正确显示
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "USER_AGREEMENT.md");
const outDir = path.join(root, "build");
const out = path.join(outDir, "license.txt");

const mdToText = (md: string): string => {
  return md
    .replace(/<br\s*\/?>/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^---+\s*$/gm, "─".repeat(60))
    .replace(/^\s*[-*]\s+/gm, "  • ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/** 主函数 */
const main = (): void => {
  try {
    const raw = fs.readFileSync(src, "utf-8");
    const text = mdToText(raw);
    const final = "\ufeff" + text.replace(/\r?\n/g, "\r\n") + "\r\n";

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(out, final, "utf-8");

    console.log(`license generated: ${path.relative(root, out)} (${final.length} chars)`);
  } catch (err) {
    console.error("生成 license.txt 失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
};

main();
