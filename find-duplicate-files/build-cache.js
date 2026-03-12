#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { buildCacheForFolder } = require('./hash-cache-core');

// 列出獨立快取建置工具的使用方式。
function printUsage() {
  console.log('用法: node build-cache.js <folder1> [folder2 ...]');
  console.log('範例: node build-cache.js "D:\\\\A" "E:\\\\B"');
}

async function main() {
  // 將輸入路徑轉成絕對路徑，避免相對路徑造成混淆。
  const folders = process.argv.slice(2).map((folder) => path.resolve(folder));
  if (folders.length === 0) {
    printUsage();
    process.exit(2);
  }

  for (const rootDir of folders) {
    let stat;
    try {
      stat = await fs.promises.stat(rootDir);
    } catch {
      console.error(`找不到資料夾: ${rootDir}`);
      process.exitCode = 2;
      continue;
    }
    if (!stat.isDirectory()) {
      console.error(`不是資料夾: ${rootDir}`);
      process.exitCode = 2;
      continue;
    }

    // 單資料夾建置/更新快取，逐一輸出統計資訊。
    console.log(`\n建立/更新快取: ${rootDir}`);
    const result = await buildCacheForFolder(rootDir);
    console.log(`完成: ${result.rootDir}`);
    console.log(`快取檔: ${result.cacheFilePath}`);
    console.log(`檔案數: ${result.fileCount}`);
    console.log(`嚴格快取命中: ${result.strictCacheHit}`);
    console.log(`可攜快取重用命中: ${result.portableCacheHit}`);
    console.log(`內容雜湊重新計算: ${result.hashRecalc}`);
    console.log(`中途存檔次數（checkpoint）: ${result.checkpointSaves}`);
    console.log(`清理過期快取筆數: ${result.removedStale}`);
  }
}

main().catch((err) => {
  console.error('執行失敗:', err.message);
  process.exit(1);
});
