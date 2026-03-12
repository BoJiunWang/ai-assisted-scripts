const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_FILE_NAME = '.duplicate-hash-cache.json';
const FINGERPRINT_SAMPLE_SIZE = 64 * 1024;
const DEFAULT_CACHE_CHECKPOINT_EVERY_FILES = 200;
const DEFAULT_CACHE_CHECKPOINT_EVERY_MS = 5000;

// 解析環境變數為正整數；若無效則回退預設值。
function parsePositiveIntEnv(varName, fallbackValue, minValue = 1) {
  const raw = process.env[varName];
  if (raw === undefined || raw === null || raw === '') {
    return fallbackValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallbackValue;
  }
  const value = Math.floor(parsed);
  if (value < minValue) {
    return fallbackValue;
  }
  return value;
}

const CACHE_CHECKPOINT_EVERY_FILES = parsePositiveIntEnv(
  'DUP_CACHE_CHECKPOINT_FILES',
  DEFAULT_CACHE_CHECKPOINT_EVERY_FILES,
  1
);
const CACHE_CHECKPOINT_EVERY_MS = parsePositiveIntEnv(
  'DUP_CACHE_CHECKPOINT_MS',
  DEFAULT_CACHE_CHECKPOINT_EVERY_MS,
  1
);

// 以疊代方式深度優先走訪資料夾，避免深層遞迴造成堆疊風險。
async function* walkFilesDepthFirst(rootDir) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = entries[entryIndex];
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  }
}

function toRelativePathKey(rootDir, filePath) {
  return path.relative(rootDir, filePath);
}

// 用檔案大小與時間戳組合成快取簽章，用來判斷快取是否可用。
function buildFileSignature(stat) {
  // 使用較強的中繼資料簽章，降低過期快取誤命中的風險。
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function buildPortableFileSignature(stat) {
  return `${stat.size}`;
}

// 串流計算雜湊，避免一次讀入整檔造成記憶體壓力。
function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function computeQuickFingerprint(filePath, stat, sampleSize = FINGERPRINT_SAMPLE_SIZE) {
  // 快速指紋會混合檔案大小與三段抽樣內容，降低誤判機率。
  const size = stat.size;
  const hash = crypto.createHash('sha1');
  hash.update(String(size));

  if (size === 0) {
    return hash.digest('hex');
  }

  const positions = [
    0,
    Math.max(0, Math.floor(size / 2) - Math.floor(sampleSize / 2)),
    Math.max(0, size - sampleSize),
  ];

  const uniquePositions = [...new Set(positions)];
  const fileHandle = await fs.promises.open(filePath, 'r');
  try {
    for (const pos of uniquePositions) {
      const len = Math.min(sampleSize, size - pos);
      if (len <= 0) {
        continue;
      }
      const buffer = Buffer.allocUnsafe(len);
      const { bytesRead } = await fileHandle.read(buffer, 0, len, pos);
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await fileHandle.close();
  }

  return hash.digest('hex');
}

async function loadCache(cacheFilePath) {
  // 快取檔不存在或格式錯誤時，回傳空結構避免中斷流程。
  try {
    const raw = await fs.promises.readFile(cacheFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') {
      return { entries: {} };
    }
    return { entries: parsed.entries };
  } catch {
    return { entries: {} };
  }
}

async function saveCache(cacheFilePath, cache) {
  // 先寫入暫存檔再 rename，降低中途失敗造成壞檔的機率。
  const serialized = `${JSON.stringify(cache, null, 2)}\n`;
  const tmpPath = `${cacheFilePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmpPath, serialized, 'utf8');
  try {
    await fs.promises.rename(tmpPath, cacheFilePath);
  } catch (err) {
    if (err && (err.code === 'EEXIST' || err.code === 'EPERM')) {
      try {
        await fs.promises.unlink(cacheFilePath);
      } catch (unlinkErr) {
        if (!unlinkErr || unlinkErr.code !== 'ENOENT') {
          throw unlinkErr;
        }
      }
      await fs.promises.rename(tmpPath, cacheFilePath);
    } else {
      throw err;
    }
  } finally {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // 暫存檔可能已在 rename 時移動完成。
    }
  }
}

function createProgressTracker(total, label) {
  if (total <= 0) {
    return { tick() {}, done() {} };
  }

  let current = 0;
  let lastLogged = -1;
  let finished = false;
  const barWidth = 30;

  function render(force = false) {
    const safeTotal = Math.max(total, current, 1);
    const percent = Math.floor((current / safeTotal) * 100);
    if (!force && percent === lastLogged && current !== total) {
      return;
    }
    lastLogged = percent;

    const filled = Math.max(0, Math.min(barWidth, Math.floor((current / safeTotal) * barWidth)));
    const bar = `${'#'.repeat(filled)}${'-'.repeat(Math.max(0, barWidth - filled))}`;
    // 使用單行覆寫輸出，避免大量進度訊息洗版。
    process.stdout.write(`\r${label} [${bar}] ${percent}% (${current}/${safeTotal})`);
    if (current >= total) {
      finished = true;
      process.stdout.write('\n');
    }
  }

  return {
    tick() {
      current += 1;
      render(false);
    },
    done() {
      if (finished) {
        return;
      }
      current = total;
      render(true);
    },
  };
}

function createCacheContext(rootDir) {
  // 每個根資料夾各自持有一份獨立快取上下文。
  return {
    rootDir,
    cacheFilePath: path.join(rootDir, CACHE_FILE_NAME),
    cache: { entries: {} },
  };
}

async function loadContextCache(context) {
  context.cache = await loadCache(context.cacheFilePath);
  return context;
}

async function saveContextCache(context) {
  await saveCache(context.cacheFilePath, context.cache);
}

async function collectFiles(rootDir) {
  const files = [];
  for await (const filePath of walkFilesDepthFirst(rootDir)) {
    const relPath = toRelativePathKey(rootDir, filePath);
    if (relPath === CACHE_FILE_NAME) {
      continue;
    }
    files.push(filePath);
  }
  return files;
}

async function buildFingerprintMapWithCache(context, files, fileIndex, progressTracker) {
  const { rootDir, cache } = context;
  const cacheEntries = cache.entries;
  const map = new Map();
  const seenRelPaths = new Set();
  let fingerprintCacheHit = 0;
  let fingerprintRecalc = 0;

  for (const filePath of files) {
    const relPath = toRelativePathKey(rootDir, filePath);
    seenRelPaths.add(relPath);

    const stat = await fs.promises.stat(filePath);
    const signature = buildFileSignature(stat);

    let cacheItem = cacheEntries[relPath];
    let fingerprint;

    // 快取命中時直接使用既有快速指紋，否則重新計算並回寫。
    if (cacheItem && cacheItem.sig === signature && typeof cacheItem.fingerprint === 'string') {
      fingerprint = cacheItem.fingerprint;
      fingerprintCacheHit += 1;
    } else {
      fingerprint = await computeQuickFingerprint(filePath, stat);
      fingerprintRecalc += 1;
      cacheItem = {
        sig: signature,
        portableSig: buildPortableFileSignature(stat),
        fingerprint,
        md5: cacheItem && cacheItem.sig === signature ? cacheItem.md5 : undefined,
        sha256: cacheItem && cacheItem.sig === signature ? cacheItem.sha256 : undefined,
      };
      cacheEntries[relPath] = cacheItem;
    }

    fileIndex.set(filePath, { context, relPath });

    if (!map.has(fingerprint)) {
      map.set(fingerprint, []);
    }
    map.get(fingerprint).push(filePath);

    progressTracker.tick();
  }

  return { map, seenRelPaths, fingerprintCacheHit, fingerprintRecalc };
}

async function getMd5WithCache(filePath, fileIndex, md5RuntimeCache, stats = null) {
  const ref = fileIndex.get(filePath);
  if (!ref) {
    throw new Error(`找不到快取索引: ${filePath}`);
  }

  const { context, relPath } = ref;
  const cacheEntries = context.cache.entries;

  const stat = await fs.promises.stat(filePath);
  const signature = buildFileSignature(stat);
  const runtimeEntry = md5RuntimeCache.get(filePath);
  // 同一輪執行優先命中記憶體快取，避免重複計算。
  if (runtimeEntry && runtimeEntry.sig === signature) {
    return runtimeEntry.digest;
  }

  const cacheItem = cacheEntries[relPath];

  let md5;
  // 簽章一致才信任磁碟快取，確保檔案變更後不會誤用舊值。
  if (cacheItem && cacheItem.sig === signature && typeof cacheItem.md5 === 'string') {
    md5 = cacheItem.md5;
    if (stats) {
      stats.cacheHit += 1;
    }
  } else {
    md5 = await hashFile(filePath, 'md5');
    if (stats) {
      stats.recalc += 1;
    }
    cacheEntries[relPath] = {
      sig: signature,
      portableSig: buildPortableFileSignature(stat),
      fingerprint: cacheItem && cacheItem.sig === signature ? cacheItem.fingerprint : undefined,
      md5,
      sha256: cacheItem && cacheItem.sig === signature ? cacheItem.sha256 : undefined,
    };
  }

  md5RuntimeCache.set(filePath, { sig: signature, digest: md5 });
  return md5;
}

async function getSha256WithCache(
  filePath,
  fileIndex,
  sha256RuntimeCache,
  stats = null,
  options = {}
) {
  const { trustPersistentCache = true } = options;

  const ref = fileIndex.get(filePath);
  if (!ref) {
    throw new Error(`找不到快取索引: ${filePath}`);
  }

  const { context, relPath } = ref;
  const cacheEntries = context.cache.entries;

  const stat = await fs.promises.stat(filePath);
  const signature = buildFileSignature(stat);
  const runtimeEntry = sha256RuntimeCache.get(filePath);
  // 同一輪執行優先命中記憶體快取，避免重複計算。
  if (runtimeEntry && runtimeEntry.sig === signature) {
    return runtimeEntry.digest;
  }

  const cacheItem = cacheEntries[relPath];

  let sha256;
  // 依選項決定是否信任磁碟快取；預設可信任，呼叫端可覆寫。
  if (
    trustPersistentCache &&
    cacheItem &&
    cacheItem.sig === signature &&
    typeof cacheItem.sha256 === 'string'
  ) {
    sha256 = cacheItem.sha256;
    if (stats) {
      stats.cacheHit += 1;
    }
  } else {
    sha256 = await hashFile(filePath, 'sha256');
    if (stats) {
      stats.recalc += 1;
    }
    cacheEntries[relPath] = {
      sig: signature,
      portableSig: buildPortableFileSignature(stat),
      fingerprint: cacheItem && cacheItem.sig === signature ? cacheItem.fingerprint : undefined,
      md5: cacheItem && cacheItem.sig === signature ? cacheItem.md5 : undefined,
      sha256,
    };
  }

  sha256RuntimeCache.set(filePath, { sig: signature, digest: sha256 });
  return sha256;
}

function pruneStaleCacheEntries(cacheEntries, validRelPaths) {
  // 掃描結束後移除已不存在的舊路徑，避免快取持續膨脹。
  let removed = 0;
  Object.keys(cacheEntries).forEach((relPath) => {
    if (!validRelPaths.has(relPath)) {
      delete cacheEntries[relPath];
      removed += 1;
    }
  });
  return removed;
}

async function buildCacheForFolder(rootDir, label = null) {
  const context = createCacheContext(rootDir);
  await loadContextCache(context);

  const files = await collectFiles(rootDir);
  const tracker = createProgressTracker(files.length, label || `CACHE ${rootDir}`);

  let strictCacheHit = 0;
  let portableCacheHit = 0;
  let hashRecalc = 0;
  let checkpointSaves = 0;
  const seenRelPaths = new Set();
  let dirtySinceLastSave = 0;
  let lastCheckpointAt = Date.now();

  async function flushCheckpointIfNeeded(force = false) {
    if (dirtySinceLastSave <= 0) {
      return;
    }
    const now = Date.now();
    const shouldFlushByCount = dirtySinceLastSave >= CACHE_CHECKPOINT_EVERY_FILES;
    const shouldFlushByTime = now - lastCheckpointAt >= CACHE_CHECKPOINT_EVERY_MS;
    // 依筆數或時間門檻進行中途落盤；force 時一定落盤。
    if (!force && !shouldFlushByCount && !shouldFlushByTime) {
      return;
    }
    await saveContextCache(context);
    checkpointSaves += 1;
    dirtySinceLastSave = 0;
    lastCheckpointAt = now;
  }

  for (const filePath of files) {
    const relPath = toRelativePathKey(rootDir, filePath);
    seenRelPaths.add(relPath);

    const stat = await fs.promises.stat(filePath);
    const signature = buildFileSignature(stat);
    const portableSig = buildPortableFileSignature(stat);
    let cacheItem = context.cache.entries[relPath];

    // 嚴格命中：簽章完全一致且已有 md5。
    if (cacheItem && cacheItem.sig === signature && typeof cacheItem.md5 === 'string') {
      strictCacheHit += 1;
      tracker.tick();
      continue;
    }

    // 可攜命中：簽章不一致時，改用大小 + 快速指紋驗證是否可重用 md5。
    if (
      cacheItem &&
      cacheItem.portableSig === portableSig &&
      typeof cacheItem.fingerprint === 'string' &&
      typeof cacheItem.md5 === 'string'
    ) {
      const fingerprint = await computeQuickFingerprint(filePath, stat);
      if (fingerprint === cacheItem.fingerprint) {
        portableCacheHit += 1;
        context.cache.entries[relPath] = {
          sig: signature,
          portableSig,
          fingerprint,
          md5: cacheItem.md5,
          sha256: cacheItem && cacheItem.sig === signature ? cacheItem.sha256 : undefined,
        };
        dirtySinceLastSave += 1;
        await flushCheckpointIfNeeded(false);
        tracker.tick();
        continue;
      }
    }

    {
      // 仍無法命中時，才進行完整 md5 重算並更新快取。
      const [fingerprint, md5] = await Promise.all([
        computeQuickFingerprint(filePath, stat),
        hashFile(filePath, 'md5'),
      ]);
      hashRecalc += 1;
      context.cache.entries[relPath] = {
        sig: signature,
        portableSig,
        fingerprint,
        md5,
        sha256: cacheItem && cacheItem.sig === signature ? cacheItem.sha256 : undefined,
      };
      dirtySinceLastSave += 1;
    }

    await flushCheckpointIfNeeded(false);
    tracker.tick();
  }

  tracker.done();

  const removedStale = pruneStaleCacheEntries(context.cache.entries, seenRelPaths);
  if (removedStale > 0) {
    dirtySinceLastSave += removedStale;
  }
  await flushCheckpointIfNeeded(true);

  return {
    rootDir,
    cacheFilePath: context.cacheFilePath,
    fileCount: files.length,
    strictCacheHit,
    portableCacheHit,
    hashRecalc,
    checkpointSaves,
    removedStale,
  };
}

module.exports = {
  CACHE_FILE_NAME,
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
};
