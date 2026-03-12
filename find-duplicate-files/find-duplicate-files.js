#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const core = require('./hash-cache-core');

const {
  createCacheContext,
  loadContextCache,
  saveContextCache,
  createProgressTracker,
  collectFiles,
  buildFingerprintMapWithCache,
  getMd5WithCache,
  getSha256WithCache,
  pruneStaleCacheEntries,
  buildCacheForFolder,
} = core;

const EXIT_RUNTIME_ERROR = 1;
const EXIT_USAGE_ERROR = 2;

// 包裝 readline 問答為 Promise，便於以 async/await 使用。
function promptInput(question, readlineInterface) {
  return new Promise((resolve) =>
    readlineInterface.question(question, (answer) => resolve(answer.trim()))
  );
}

function printUsage() {
  console.log('用法: node find-duplicate-files.js <find-duplicates|find-missing|sync-missing|make-cache> <folder1> [folder2 ...] [--apply]');
  console.log('說明: node find-duplicate-files.js --help');
  console.log('範例1: node find-duplicate-files.js find-duplicates ./dirA ./dirB');
  console.log('範例2: node find-duplicate-files.js find-missing ./dirA ./dirB ./dirC');
  console.log('範例3: node find-duplicate-files.js sync-missing ./dirA ./dirB ./dirC');
  console.log('範例4: node find-duplicate-files.js sync-missing ./dirA ./dirB ./dirC --apply');
  console.log('範例5: node find-duplicate-files.js make-cache ./dirA ./dirB');
}

// 解析 CLI 參數並做基礎驗證，同時去除重複資料夾輸入。
function parseArgs(argv) {
  if (argv.length < 2) {
    throw new Error('至少要提供模式與資料夾');
  }

  const mode = argv[0];
  if (!['find-duplicates', 'find-missing', 'sync-missing', 'make-cache'].includes(mode)) {
    throw new Error(`不支援的模式: ${mode}（只支援 find-duplicates、find-missing、sync-missing、make-cache）`);
  }

  const options = new Set();
  const folderArgs = [];
  for (let argIndex = 1; argIndex < argv.length; argIndex += 1) {
    const arg = argv[argIndex];
    if (arg === '--apply') {
      options.add('apply');
      continue;
    }
    folderArgs.push(arg);
  }

  if (mode !== 'sync-missing' && options.has('apply')) {
    throw new Error('--apply 只支援 sync-missing');
  }

  const rawFolders = folderArgs.map((folder) => path.resolve(folder));
  const folders = [...new Set(rawFolders)];

  if (folders.length === 0) {
    throw new Error('至少要提供一個資料夾路徑');
  }

  return {
    mode,
    folders: folders.map((folder) => path.resolve(folder)),
    apply: options.has('apply'),
  };
}

async function validateFolders(folders) {
  // 逐一確認路徑存在且為資料夾。
  for (const dir of folders) {
    let stat;
    try {
      stat = await fs.promises.stat(dir);
    } catch {
      throw new Error(`找不到資料夾: ${dir}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`不是資料夾: ${dir}`);
    }
  }
}

function printScanHeader(mode, folders, contexts) {
  console.log('掃描中...');
  if (mode === 'find-missing') {
    console.log('模式: 差異清單（A 有、B 沒有）');
  } else if (mode === 'sync-missing') {
    console.log('模式: 多資料夾互補同步（不刪檔）');
  } else {
    console.log('模式: 重複比對');
  }
  console.log(`資料夾數量: ${folders.length}`);
  folders.forEach((folder, folderIndex) => {
    console.log(`[${folderIndex + 1}] ${folder}`);
    console.log(`    快取檔: ${contexts[folderIndex].cacheFilePath}`);
  });
  if (mode === 'find-missing' || mode === 'sync-missing') {
    console.log('流程: 先快速指紋，再 MD5 驗證\n');
  } else {
    console.log('流程: 先快速指紋，再 MD5，最後 SHA256 驗證\n');
  }
}

// 依資料夾索引回傳穩定顏色，幫助人眼辨識輸出來源。
function createFolderColorizer() {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return (_folderIndex, text) => text;
  }

  // 使用固定色盤，確保相同輸入資料夾在每次輸出顯示一致顏色。
  const palette = [
    { fg: 97, bg: 41 },  // 白字紅底
    { fg: 97, bg: 44 },  // 白字藍底
    { fg: 30, bg: 43 },  // 黑字黃底
    { fg: 97, bg: 45 },  // 白字洋紅底
    { fg: 30, bg: 46 },  // 黑字青底
    { fg: 30, bg: 102 }, // 黑字亮綠底
    { fg: 97, bg: 100 }, // 白字亮黑底
    { fg: 30, bg: 106 }, // 黑字亮青底
  ];

  return (folderIdx, text) => {
    const style = palette[folderIdx % palette.length];
    return `\x1b[${style.fg};${style.bg}m ${text} \x1b[0m`;
  };
}

function shouldCompareAcrossFolders(folderCount, files) {
  // 單資料夾模式允許資料夾內重複；多資料夾模式至少要跨資料夾才算候選。
  if (folderCount === 1) {
    return files.length >= 2;
  }
  return new Set(files.map((item) => item.folderIdx)).size >= 2;
}

function getRelativeDir(rootDir, filePath) {
  const relPath = path.relative(rootDir, filePath);
  const relDir = path.dirname(relPath);
  return relDir === '.' ? '' : relDir;
}

function buildSuffixedPath(filePath, sequenceNumber) {
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  const dirName = path.dirname(filePath);
  return path.join(dirName, `${baseName} (${sequenceNumber})${ext}`);
}

async function findNextAvailableSuffixedPath(filePath) {
  let sequenceNumber = 1;
  while (true) {
    const candidatePath = buildSuffixedPath(filePath, sequenceNumber);
    try {
      await fs.promises.access(candidatePath, fs.constants.F_OK);
      sequenceNumber += 1;
    } catch {
      return candidatePath;
    }
  }
}

// 先建好每個資料夾的快速指紋分組索引，供後續模式共用。
async function scanWithFingerprint(contexts, folders) {
  const filesPerFolder = await Promise.all(
    folders.map(async (folder) => {
      const files = await collectFiles(folder);
      return files.sort((a, b) => a.localeCompare(b));
    })
  );
  const totalFiles = filesPerFolder.reduce((sum, files) => sum + files.length, 0);
  const fingerprintProgress = createProgressTracker(totalFiles, '快速指紋進度');

  const fileIndex = new Map();
  const scans = await Promise.all(
    contexts.map((context, folderIndex) =>
      buildFingerprintMapWithCache(context, filesPerFolder[folderIndex], fileIndex, fingerprintProgress)
    )
  );
  fingerprintProgress.done();

  return { scans, fileIndex };
}

function createMd5Accessor(fileIndex, stats = null, progressTracker = null) {
  const runtimeCache = new Map();
  // 回傳閉包，封裝每輪執行的 md5 記憶體快取。
  return async function getMd5(filePath) {
    const hadCached = runtimeCache.has(filePath);
    const md5 = await getMd5WithCache(filePath, fileIndex, runtimeCache, stats);
    if (!hadCached && progressTracker) {
      progressTracker.tick();
    }
    return md5;
  };
}

function createShaAccessor(fileIndex, progressTracker = null, options = {}) {
  const runtimeCache = new Map();
  const { trustPersistentCache = false } = options;

  return async function getSha(filePath) {
    const hadCached = runtimeCache.has(filePath);
    const sha = await getSha256WithCache(
      filePath,
      fileIndex,
      runtimeCache,
      null,
      { trustPersistentCache }
    );
    if (!hadCached && progressTracker) {
      progressTracker.tick();
    }
    return sha;
  };
}

function buildFingerprintGroupMap(scans) {
  // 將每個資料夾各自的指紋分組，合併成全域指紋視圖。
  const fingerprintGroupMap = new Map();
  scans.forEach((scan, folderIdx) => {
    for (const [fingerprint, files] of scan.map.entries()) {
      if (!fingerprintGroupMap.has(fingerprint)) {
        fingerprintGroupMap.set(fingerprint, []);
      }
      fingerprintGroupMap.get(fingerprint).push({ folderIdx, files });
    }
  });
  return fingerprintGroupMap;
}

async function runDuplicateMode({ folders, scans, fileIndex }) {
  const fingerprintGroupMap = buildFingerprintGroupMap(scans);
  const getMd5 = createMd5Accessor(fileIndex);
  const getSha = createShaAccessor(fileIndex);
  const colorFolder = createFolderColorizer();

  let fingerprintCandidateGroups = 0;
  let md5CandidateGroups = 0;
  let confirmedGroupsCount = 0;
  let confirmedFilesTotal = 0;
  const confirmedGroups = [];

  // 穩定排序輸出，方便 diff 與自動化處理。
  const sortedFingerprints = [...fingerprintGroupMap.keys()].sort((a, b) => a.localeCompare(b));
  for (const fingerprint of sortedFingerprints) {
    const folderBuckets = fingerprintGroupMap.get(fingerprint);
    const allFingerprintFiles = folderBuckets.flatMap((bucket) =>
      bucket.files.map((filePath) => ({ filePath, folderIdx: bucket.folderIdx }))
    );
    allFingerprintFiles.sort((a, b) => {
      if (a.folderIdx !== b.folderIdx) {
        return a.folderIdx - b.folderIdx;
      }
      return a.filePath.localeCompare(b.filePath);
    });

    if (!shouldCompareAcrossFolders(folders.length, allFingerprintFiles)) {
      continue;
    }

    fingerprintCandidateGroups += 1;

    // 第二層：同一快速指紋下再用 MD5 收斂候選。
    const md5Map = new Map();
    for (const item of allFingerprintFiles) {
      const md5 = await getMd5(item.filePath);
      if (!md5Map.has(md5)) {
        md5Map.set(md5, []);
      }
      md5Map.get(md5).push(item);
    }

    const sortedMd5Digests = [...md5Map.keys()].sort((a, b) => a.localeCompare(b));
    for (const md5Digest of sortedMd5Digests) {
      const allMd5Files = md5Map.get(md5Digest);
      if (!shouldCompareAcrossFolders(folders.length, allMd5Files)) {
        continue;
      }

      md5CandidateGroups += 1;

      // 第三層：以 SHA256 做最終確認，避免碰撞誤判。
      const shaMap = new Map();
      for (const item of allMd5Files) {
        const sha = await getSha(item.filePath);
        if (!shaMap.has(sha)) {
          shaMap.set(sha, []);
        }
        shaMap.get(sha).push(item);
      }

      const sortedShaDigests = [...shaMap.keys()].sort((a, b) => a.localeCompare(b));
      for (const shaDigest of sortedShaDigests) {
        const shaFiles = shaMap.get(shaDigest);
        if (!shouldCompareAcrossFolders(folders.length, shaFiles)) {
          continue;
        }

        confirmedGroupsCount += 1;
        confirmedFilesTotal += shaFiles.length;
        confirmedGroups.push({ md5Digest, shaDigest, files: shaFiles });

        console.log(`快速指紋候選: ${fingerprint}`);
        console.log(`MD5 候選: ${md5Digest}`);
        console.log(`SHA256 確認: ${shaDigest}`);

        const byFolder = new Map();
        for (const item of shaFiles) {
          if (!byFolder.has(item.folderIdx)) {
            byFolder.set(item.folderIdx, []);
          }
          byFolder.get(item.folderIdx).push(item.filePath);
        }

        const sortedFolderIndexes = [...byFolder.keys()].sort((a, b) => a - b);
        for (const folderIndex of sortedFolderIndexes) {
          const filePaths = byFolder.get(folderIndex).slice().sort((a, b) => a.localeCompare(b));
          const tag = colorFolder(folderIndex, `資料夾${folderIndex + 1}`);
          console.log(`  [${folderIndex + 1}] ${tag} ${folders[folderIndex]}:`);
          filePaths.forEach((filePath) => console.log(`    - ${filePath}`));
        }
        console.log('');
      }
    }
  }

  console.log('完成');
  console.log(`快速指紋疑似重複群組數: ${fingerprintCandidateGroups}`);
  console.log(`MD5 疑似重複群組數: ${md5CandidateGroups}`);
  console.log(`重複雜湊群組數: ${confirmedGroupsCount}`);
  console.log(`重複檔案總數: ${confirmedFilesTotal}`);

  if (confirmedGroups.length === 0) {
    return 0;
  }

  // 互動刪除僅在使用者明確確認後才進入。
  const readlineInterface = readline.createInterface({ input: process.stdin, output: process.stdout });
  let deletedCount = 0;

  try {
    const runDeleteMode = await promptInput('\n要進入互動刪除模式嗎？(y/N): ', readlineInterface);
    if (!/^y(es)?$/i.test(runDeleteMode)) {
      return 0;
    }

    console.log('\n互動刪除模式啟動：輸入編號可刪除多個檔案(例如 2,4)。');
    console.log("輸入 's' 跳過該群組，輸入 'q' 直接結束刪除流程。\n");

    for (let groupIndex = 0; groupIndex < confirmedGroups.length; groupIndex += 1) {
      const group = confirmedGroups[groupIndex];

      console.log(`群組 ${groupIndex + 1}/${confirmedGroups.length}`);
      console.log(`  MD5: ${group.md5Digest}`);
      console.log(`  SHA256: ${group.shaDigest}`);
      group.files.forEach((item, fileIndexInGroup) => {
        const tag = colorFolder(item.folderIdx, `資料夾${item.folderIdx + 1}`);
        console.log(`  [${fileIndexInGroup + 1}] (${tag}) ${item.filePath}`);
      });

      const input = await promptInput('請輸入要刪除的編號 (s=跳過, q=結束): ', readlineInterface);
      if (/^q$/i.test(input)) {
        break;
      }
      if (/^s?$/i.test(input)) {
        console.log('');
        continue;
      }

      const indexes = [...new Set(
        input
          .split(',')
          .map((v) => Number(v.trim()))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= group.files.length)
      )];

      if (indexes.length === 0) {
        console.log('  無有效編號，跳過此群組。\n');
        continue;
      }

      for (const idx of indexes) {
        const targetFilePath = group.files[idx - 1].filePath;
        const ref = fileIndex.get(targetFilePath);
        try {
          await fs.promises.unlink(targetFilePath);
          deletedCount += 1;
          if (ref) {
            delete ref.context.cache.entries[ref.relPath];
          }
          console.log(`  已刪除: ${targetFilePath}`);
        } catch (err) {
          console.log(`  刪除失敗: ${targetFilePath} (${err.message})`);
        }
      }
      console.log('');
    }
  } finally {
    readlineInterface.close();
  }

  console.log(`互動刪除完成，總刪除檔案數: ${deletedCount}`);
  return deletedCount;
}

function estimateMissingMd5Work(scans) {
  const requiredPaths = new Set();
  const fingerprintGroupMap = buildFingerprintGroupMap(scans);

  for (const buckets of fingerprintGroupMap.values()) {
    if (buckets.length < 2) {
      continue;
    }
    buckets.forEach((bucket) => {
      bucket.files.forEach((filePath) => requiredPaths.add(filePath));
    });
  }

  return requiredPaths.size;
}

function estimateSyncMd5WorkMulti(scans, folders, sourceIdx, targetIndexes, fileIndex) {
  const requiredPaths = new Set();
  const sourceRoot = folders[sourceIdx];
  const sourceFingerprintMap = scans[sourceIdx].map;

  for (const targetIdx of targetIndexes) {
    const targetRoot = folders[targetIdx];
    const targetFingerprintMap = scans[targetIdx].map;

    // 保守估算同路徑衝突比對可能用到的 MD5 計算量。
    for (const sourceFiles of sourceFingerprintMap.values()) {
      for (const sourceFile of sourceFiles) {
        requiredPaths.add(sourceFile);
        const relativePath = path.relative(sourceRoot, sourceFile);
        const targetFile = path.join(targetRoot, relativePath);
        if (fileIndex.has(targetFile)) {
          requiredPaths.add(targetFile);
        }
      }
    }

    // 指紋重疊時會進一步做 MD5 比對，先把候選都算進估算值。
    for (const [fingerprint, sourceFiles] of sourceFingerprintMap.entries()) {
      const targetFiles = targetFingerprintMap.get(fingerprint);
      if (!targetFiles) {
        continue;
      }
      sourceFiles.forEach((filePath) => requiredPaths.add(filePath));
      targetFiles.forEach((filePath) => requiredPaths.add(filePath));
    }
  }

  return requiredPaths.size;
}

function hashFileMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function applyQueuedSyncActions({
  actions,
  fileIndex,
  contexts,
  scans,
  getMd5,
}) {
  let copied = 0;
  let skippedSame = 0;
  let renamedOnConflict = 0;
  let failed = 0;

  for (const action of actions) {
    let finalTargetFile = action.targetFile;
    let sourceMd5 = null;

    while (true) {
      await fs.promises.mkdir(path.dirname(finalTargetFile), { recursive: true });
      try {
        await fs.promises.copyFile(action.srcFile, finalTargetFile, fs.constants.COPYFILE_EXCL);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') {
          failed += 1;
          console.log(`! 套用失敗: ${action.srcFile} -> ${finalTargetFile} (${err.message})`);
          finalTargetFile = null;
          break;
        }

        if (!sourceMd5) {
          sourceMd5 = await getMd5(action.srcFile);
        }
        const targetMd5 = fileIndex.has(finalTargetFile)
          ? await getMd5(finalTargetFile)
          : await hashFileMd5(finalTargetFile);

        if (sourceMd5 === targetMd5) {
          skippedSame += 1;
          console.log(`= 套用時已存在相同內容，略過: ${finalTargetFile}`);
          finalTargetFile = null;
          break;
        }

        const nextTargetFile = await findNextAvailableSuffixedPath(finalTargetFile);
        renamedOnConflict += 1;
        console.log(`~ 套用時發生衝突，改名: ${finalTargetFile} -> ${nextTargetFile}`);
        finalTargetFile = nextTargetFile;
      }
    }

    if (!finalTargetFile) {
      continue;
    }

    const targetRelPath = path.relative(action.targetRoot, finalTargetFile);
    fileIndex.set(finalTargetFile, {
      context: contexts[action.targetIdx],
      relPath: targetRelPath,
    });
    scans[action.targetIdx].seenRelPaths.add(targetRelPath);

    if (action.sourceFingerprint) {
      if (!action.targetFingerprintMap.has(action.sourceFingerprint)) {
        action.targetFingerprintMap.set(action.sourceFingerprint, []);
      }
      const bucket = action.targetFingerprintMap.get(action.sourceFingerprint);
      if (!bucket.includes(finalTargetFile)) {
        bucket.push(finalTargetFile);
        bucket.sort((a, b) => a.localeCompare(b));
      }
    }

    copied += 1;
    console.log(`+ 已套用複製: ${action.srcFile} -> ${finalTargetFile}`);
  }

  return { copied, skippedSame, renamedOnConflict, failed };
}

async function runMissingMode({ folders, scans, fileIndex }) {
  if (folders.length < 2) {
    console.log('差異清單模式至少需要 2 個資料夾。');
    return;
  }

  const md5Progress = createProgressTracker(estimateMissingMd5Work(scans), 'MD5 驗證進度');
  const getMd5 = createMd5Accessor(fileIndex, null, md5Progress);

  let pairCount = 0;
  let missingFilesTotal = 0;

  for (let sourceIndex = 0; sourceIndex < folders.length; sourceIndex += 1) {
    for (let targetIndex = 0; targetIndex < folders.length; targetIndex += 1) {
      if (sourceIndex === targetIndex) {
        continue;
      }

      const sourceFingerprintMap = scans[sourceIndex].map;
      const targetFingerprintMap = scans[targetIndex].map;
      const sourceOnlyFiles = [];

      // 以兩層流程判定「來源有、目標沒有」：快速指紋 -> MD5。
      const sortedFingerprints = [...sourceFingerprintMap.keys()].sort((a, b) => a.localeCompare(b));
      for (const fingerprint of sortedFingerprints) {
        const sourceFiles = sourceFingerprintMap.get(fingerprint).slice().sort((a, b) => a.localeCompare(b));
        const targetFiles = targetFingerprintMap.get(fingerprint);
        if (!targetFiles) {
          sourceOnlyFiles.push(...sourceFiles);
          continue;
        }

        const sourceMd5Groups = new Map();
        for (const sourceFilePath of sourceFiles) {
          const md5 = await getMd5(sourceFilePath);
          if (!sourceMd5Groups.has(md5)) {
            sourceMd5Groups.set(md5, []);
          }
          sourceMd5Groups.get(md5).push(sourceFilePath);
        }

        const targetMd5Groups = new Map();
        for (const targetFilePath of targetFiles.slice().sort((a, b) => a.localeCompare(b))) {
          const md5 = await getMd5(targetFilePath);
          if (!targetMd5Groups.has(md5)) {
            targetMd5Groups.set(md5, []);
          }
          targetMd5Groups.get(md5).push(targetFilePath);
        }

        const sortedMd5Digests = [...sourceMd5Groups.keys()].sort((a, b) => a.localeCompare(b));
        for (const md5Digest of sortedMd5Digests) {
          const sourceMd5Files = sourceMd5Groups.get(md5Digest);
          const targetMd5Files = targetMd5Groups.get(md5Digest);
          if (!targetMd5Files) {
            sourceOnlyFiles.push(...sourceMd5Files);
          }
        }
      }

      sourceOnlyFiles.sort((a, b) => a.localeCompare(b));
      pairCount += 1;
      missingFilesTotal += sourceOnlyFiles.length;
      console.log(`\n[${sourceIndex + 1}] 有、[${targetIndex + 1}] 沒有: ${sourceOnlyFiles.length} 個`);
      console.log(`  [${sourceIndex + 1}] ${folders[sourceIndex]}`);
      console.log(`  [${targetIndex + 1}] ${folders[targetIndex]}`);
      sourceOnlyFiles.forEach((filePath) => console.log(`    - ${filePath}`));
    }
  }

  md5Progress.done();
  console.log('\n完成');
  console.log(`\n差異配對總數: ${pairCount}`);
  console.log(`差異檔案總數: ${missingFilesTotal}`);

  if (folders.length === 2 && missingFilesTotal > 0) {
    const sourceFolder = folders[0];
    const targetFolder = folders[1];
    console.log('\n下一步建議:');
    console.log('1. 先用預覽模式檢查補檔結果');
    console.log(`   node /Users/ivan/find-duplicate-files/find-duplicate-files.js sync-missing "${sourceFolder}" "${targetFolder}"`);
    console.log('2. 確認後再套用 --apply');
    console.log(`   node /Users/ivan/find-duplicate-files/find-duplicate-files.js sync-missing "${sourceFolder}" "${targetFolder}" --apply`);
  }
}

async function runSyncMissingMode({ folders, scans, fileIndex, contexts, apply }) {
  if (folders.length < 2) {
    throw new Error('sync-missing 至少需要 2 個資料夾');
  }

  let grandPlanned = 0;
  let grandCopied = 0;
  let grandSkippedSame = 0;
  let grandRenamedOnConflict = 0;
  const pendingApplyActions = [];

  // 每個資料夾都輪流當來源，對其他資料夾執行補齊。
  for (let sourceIdx = 0; sourceIdx < folders.length; sourceIdx += 1) {
    const sourceRoot = folders[sourceIdx];
    const targetIndexes = folders
      .map((_, folderIndex) => folderIndex)
      .filter((folderIndex) => folderIndex !== sourceIdx);
    const sourceFingerprintMap = scans[sourceIdx].map;
    const sourceFingerprintByPath = new Map();
    for (const [fingerprint, files] of sourceFingerprintMap.entries()) {
      for (const filePath of files) {
        sourceFingerprintByPath.set(filePath, fingerprint);
      }
    }

    const md5Progress = createProgressTracker(
      estimateSyncMd5WorkMulti(scans, folders, sourceIdx, targetIndexes, fileIndex),
      `MD5 驗證進度（來源=${sourceIdx + 1}）`
    );
    const getMd5 = createMd5Accessor(fileIndex, null, md5Progress);

    const sortedFingerprints = [...sourceFingerprintMap.keys()].sort((a, b) => a.localeCompare(b));

    let sourcePlanned = 0;
    let sourceCopied = 0;
    let sourceSkippedSame = 0;
    let sourceRenamedOnConflict = 0;

    for (const targetIdx of targetIndexes) {
      const targetRoot = folders[targetIdx];
      const targetFingerprintMap = scans[targetIdx].map;
      console.log(`\n正在比對（來源 ${sourceIdx + 1} -> 目標 ${targetIdx + 1}）...`);
      // 先計算此來源/目標配對下，目標缺少的來源檔案。
      const missingSourceFiles = [];

      for (const fingerprint of sortedFingerprints) {
        const sourceFiles = sourceFingerprintMap.get(fingerprint).slice().sort((a, b) => a.localeCompare(b));
        const targetFiles = targetFingerprintMap.get(fingerprint);
        if (!targetFiles) {
          missingSourceFiles.push(...sourceFiles);
          continue;
        }

        const sourceMd5Groups = new Map();
        for (const sourceFile of sourceFiles) {
          const md5 = await getMd5(sourceFile);
          if (!sourceMd5Groups.has(md5)) {
            sourceMd5Groups.set(md5, []);
          }
          sourceMd5Groups.get(md5).push(sourceFile);
        }

        const targetMd5Groups = new Map();
        for (const targetFile of targetFiles.slice().sort((a, b) => a.localeCompare(b))) {
          const md5 = await getMd5(targetFile);
          if (!targetMd5Groups.has(md5)) {
            targetMd5Groups.set(md5, new Map());
          }
          const relDir = getRelativeDir(targetRoot, targetFile);
          if (!targetMd5Groups.get(md5).has(relDir)) {
            targetMd5Groups.get(md5).set(relDir, []);
          }
          targetMd5Groups.get(md5).get(relDir).push(targetFile);
        }

        const sortedMd5Digests = [...sourceMd5Groups.keys()].sort((a, b) => a.localeCompare(b));
        for (const md5Digest of sortedMd5Digests) {
          const sourceMd5Files = sourceMd5Groups.get(md5Digest);
          const targetMd5FilesByDir = targetMd5Groups.get(md5Digest);
          if (!targetMd5FilesByDir) {
            missingSourceFiles.push(...sourceMd5Files);
            continue;
          }

          for (const sourceFile of sourceMd5Files) {
            const sourceRelDir = getRelativeDir(sourceRoot, sourceFile);
            const targetMd5FilesInSameDir = targetMd5FilesByDir.get(sourceRelDir);
            if (!targetMd5FilesInSameDir) {
              missingSourceFiles.push(sourceFile);
              continue;
            }
          }
        }
      }

      const uniqueMissing = [...new Set(missingSourceFiles)].sort((a, b) => a.localeCompare(b));
      console.log(`\n[來源 ${sourceIdx + 1} -> 目標 ${targetIdx + 1}] ${sourceRoot} -> ${targetRoot}`);
      console.log(`來源有但目標沒有的檔案數: ${uniqueMissing.length}`);

      // 將缺失轉成具體複製計畫，後續統一執行預覽或套用模式。
      const plan = [];
      for (const srcFile of uniqueMissing) {
        const relativePath = path.relative(sourceRoot, srcFile);
        const targetFile = path.join(targetRoot, relativePath);
        plan.push({ srcFile, targetFile, relativePath });
      }
      plan.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

      let copied = 0;
      let renamedOnConflict = 0;
      let skippedSame = 0;
      let planned = 0;

      for (const item of plan) {
        let targetExists = true;
        try {
          await fs.promises.access(item.targetFile, fs.constants.F_OK);
        } catch {
          targetExists = false;
        }

        // 同路徑已存在時，用 MD5 比對內容判斷「相同略過」或「衝突改名補檔」。
        if (targetExists) {
          const sourceMd5 = await getMd5(item.srcFile);
          const targetMd5 = fileIndex.has(item.targetFile)
            ? await getMd5(item.targetFile)
            : await hashFileMd5(item.targetFile);
          if (sourceMd5 === targetMd5) {
            skippedSame += 1;
            console.log(`= 已存在相同內容，略過: ${item.targetFile}`);
            continue;
          }

          const renamedTargetFile = await findNextAvailableSuffixedPath(item.targetFile);
          planned += 1;
          renamedOnConflict += 1;

          if (!apply) {
            pendingApplyActions.push({
              srcFile: item.srcFile,
              targetFile: renamedTargetFile,
              targetRoot,
              targetIdx,
              sourceFingerprint: sourceFingerprintByPath.get(item.srcFile),
              targetFingerprintMap,
            });
            console.log(`~ [預覽] 同路徑衝突，改名複製: ${item.srcFile} -> ${renamedTargetFile}`);
            continue;
          }

          await fs.promises.mkdir(path.dirname(renamedTargetFile), { recursive: true });
          await fs.promises.copyFile(item.srcFile, renamedTargetFile);

          const renamedTargetRelPath = path.relative(targetRoot, renamedTargetFile);
          fileIndex.set(renamedTargetFile, {
            context: contexts[targetIdx],
            relPath: renamedTargetRelPath,
          });
          scans[targetIdx].seenRelPaths.add(renamedTargetRelPath);

          const srcFingerprint = sourceFingerprintByPath.get(item.srcFile);
          if (srcFingerprint) {
            if (!targetFingerprintMap.has(srcFingerprint)) {
              targetFingerprintMap.set(srcFingerprint, []);
            }
            const bucket = targetFingerprintMap.get(srcFingerprint);
            if (!bucket.includes(renamedTargetFile)) {
              bucket.push(renamedTargetFile);
              bucket.sort((a, b) => a.localeCompare(b));
            }
          }

          copied += 1;
          console.log(`~ 同路徑衝突，已改名複製: ${item.srcFile} -> ${renamedTargetFile}`);
          continue;
        }

        planned += 1;
        if (!apply) {
          pendingApplyActions.push({
            srcFile: item.srcFile,
            targetFile: item.targetFile,
            targetRoot,
            targetIdx,
            sourceFingerprint: sourceFingerprintByPath.get(item.srcFile),
            targetFingerprintMap,
          });
          console.log(`+ [預覽] 將複製: ${item.srcFile} -> ${item.targetFile}`);
          continue;
        }

        // 真正複製後立即更新記憶體索引，提升同輪收斂能力。
        await fs.promises.mkdir(path.dirname(item.targetFile), { recursive: true });
        await fs.promises.copyFile(item.srcFile, item.targetFile);
        const targetRelPath = path.relative(targetRoot, item.targetFile);
        fileIndex.set(item.targetFile, {
          context: contexts[targetIdx],
          relPath: targetRelPath,
        });
        scans[targetIdx].seenRelPaths.add(targetRelPath);
        const srcFingerprint = sourceFingerprintByPath.get(item.srcFile);
        if (srcFingerprint) {
          if (!targetFingerprintMap.has(srcFingerprint)) {
            targetFingerprintMap.set(srcFingerprint, []);
          }
          const bucket = targetFingerprintMap.get(srcFingerprint);
          if (!bucket.includes(item.targetFile)) {
            bucket.push(item.targetFile);
            bucket.sort((a, b) => a.localeCompare(b));
          }
        }
        copied += 1;
        console.log(`+ 已複製: ${item.srcFile} -> ${item.targetFile}`);
      }

      sourcePlanned += planned;
      sourceCopied += copied;
      sourceSkippedSame += skippedSame;
      sourceRenamedOnConflict += renamedOnConflict;

      console.log(`配對小計（來源 ${sourceIdx + 1} -> 目標 ${targetIdx + 1}）`);
      console.log(`  可補齊檔案數: ${planned}`);
      console.log(`  實際複製數: ${copied}`);
      console.log(`  已存在相同內容略過: ${skippedSame}`);
      console.log(`  衝突改名補檔（同路徑不同內容）: ${renamedOnConflict}`);
    }

    grandPlanned += sourcePlanned;
    grandCopied += sourceCopied;
    grandSkippedSame += sourceSkippedSame;
    grandRenamedOnConflict += sourceRenamedOnConflict;
    md5Progress.done();

    console.log(`\n來源小計（來源 ${sourceIdx + 1}: ${sourceRoot}）`);
    console.log(`  可補齊檔案數: ${sourcePlanned}`);
    console.log(`  實際複製數: ${sourceCopied}`);
    console.log(`  已存在相同內容略過: ${sourceSkippedSame}`);
    console.log(`  衝突改名補檔（同路徑不同內容）: ${sourceRenamedOnConflict}`);
  }

  console.log('\n完成');
  console.log(`模式: ${apply ? '套用（--apply）' : '預覽模式（dry-run）'}`);
  console.log(`總可補齊檔案數: ${grandPlanned}`);
  console.log(`總實際複製數: ${grandCopied}`);
  console.log(`總已存在相同內容略過: ${grandSkippedSame}`);
  console.log(`總衝突改名補檔（同路徑不同內容）: ${grandRenamedOnConflict}`);

  if (apply || pendingApplyActions.length === 0) {
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('\n提示: 目前為非互動環境，若要套用請改用 --apply。');
    return;
  }

  const readlineInterface = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await promptInput('\n是否直接套用本次預覽結果？(y/N): ', readlineInterface);
    if (!/^y(es)?$/i.test(answer)) {
      return;
    }
  } finally {
    readlineInterface.close();
  }

  console.log('\n開始套用本次預覽結果（不重跑比對）...');
  const getMd5ForApply = createMd5Accessor(fileIndex);
  const applyResult = await applyQueuedSyncActions({
    actions: pendingApplyActions,
    fileIndex,
    contexts,
    scans,
    getMd5: getMd5ForApply,
  });

  console.log('\n套用完成');
  console.log(`已套用複製數: ${applyResult.copied}`);
  console.log(`套用時已存在相同內容略過: ${applyResult.skippedSame}`);
  console.log(`套用時衝突改名次數: ${applyResult.renamedOnConflict}`);
  console.log(`套用失敗數: ${applyResult.failed}`);
}

function printCacheStats(folders, scans, removedStalePerFolder) {
  // 列出每個資料夾在本輪掃描的快取命中與清理統計。
  scans.forEach((scan, folderIndex) => {
    console.log(`[${folderIndex + 1}] ${folders[folderIndex]}`);
    console.log(`  指紋快取命中: ${scan.fingerprintCacheHit}`);
    console.log(`  指紋重新計算: ${scan.fingerprintRecalc}`);
    console.log(`  清理過期快取筆數: ${removedStalePerFolder[folderIndex]}`);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    printUsage();
    return;
  }

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`參數錯誤: ${err.message}`);
    printUsage();
    process.exit(EXIT_USAGE_ERROR);
  }

  try {
    await validateFolders(parsed.folders);
  } catch (err) {
    console.error(err.message);
    process.exit(EXIT_USAGE_ERROR);
  }

  if (parsed.mode === 'find-missing' && parsed.folders.length < 2) {
    console.error('find-missing 至少需要 2 個資料夾');
    process.exit(EXIT_USAGE_ERROR);
  }

  if (parsed.mode === 'sync-missing' && parsed.folders.length < 2) {
    console.error('sync-missing 至少需要 2 個資料夾');
    process.exit(EXIT_USAGE_ERROR);
  }

  // make-cache 為獨立路徑，不需要先做全量比對掃描。
  if (parsed.mode === 'make-cache') {
    for (const rootDir of parsed.folders) {
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
    return;
  }

  // 先載入每個資料夾的快取，再進行分層掃描與模式執行。
  const contexts = parsed.folders.map((rootDir) => createCacheContext(rootDir));
  await Promise.all(contexts.map((context) => loadContextCache(context)));

  printScanHeader(parsed.mode, parsed.folders, contexts);
  const { scans, fileIndex } = await scanWithFingerprint(contexts, parsed.folders);

  if (parsed.mode === 'find-missing') {
    await runMissingMode({ folders: parsed.folders, scans, fileIndex });
  } else if (parsed.mode === 'sync-missing') {
    await runSyncMissingMode({
      folders: parsed.folders,
      scans,
      fileIndex,
      contexts,
      apply: parsed.apply,
    });
  } else {
    await runDuplicateMode({ folders: parsed.folders, scans, fileIndex });
  }

  // 任務完成後清掉過期路徑並落盤快取。
  const removedStalePerFolder = scans.map((scan, folderIndex) =>
    pruneStaleCacheEntries(contexts[folderIndex].cache.entries, scan.seenRelPaths)
  );
  await Promise.all(contexts.map((context) => saveContextCache(context)));
  printCacheStats(parsed.folders, scans, removedStalePerFolder);
}

main().catch((err) => {
  console.error('執行失敗:', err.message);
  process.exit(EXIT_RUNTIME_ERROR);
});
