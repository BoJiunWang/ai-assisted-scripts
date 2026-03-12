const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

/**
 * 計算指定檔案的 MD5 雜湊值。
 * 透過讀取檔案串流並以 crypto 模組計算，結果為十六進位字串。
 * @param {string} filePath - 要計算 MD5 的檔案完整路徑。
 * @returns {Promise<string>} - 代表檔案 MD5 雜湊值的十六進位字串。
 */
function computeMD5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * 從完整檔名中解析出「基準名稱」。
 * 此函式會移除檔名末尾常見的重複檔案後綴 (如 " (1)", "_1")，
 * 以便將相似的檔案歸為一組進行處理。
 * @param {string} filename - 原始檔案名稱。
 * @returns {string} - 清理後得到的基準檔名。
 */
function getBaseName(filename) {
  const ext = path.extname(filename);
  const name = path.basename(filename, ext);
  // 正規表示式，用以移除檔名末尾的數字後綴，例如 " (1)" 或 "_1"，以找出檔案的基準名稱。
  const cleanedName = name.replace(/(\s*|_)\(\d{1,3}\)$|[ _-]\d{1,3}$|"(\s*|_)\(\d{1,3}\)"$|"[ _]\d{1,3}"$/, '').trim();
  return cleanedName + ext;
}

/**
 * 執行檔案重新命名程序。
 * 此程序包含三個主要步驟：
 * 1. 備份所有相關檔案。
 * 2. 使用暫存檔名以避免命名衝突。
 * 3. 將檔案群組標準化為 "base.ext", "base_1.ext", "base_2.ext" 的格式。
 * @param {Map<string, string[]>} groups - 包含待處理檔案的群組 Map，鍵為基準檔名，值為原始檔名陣列。
 * @param {string} directory - 檔案所在的目標資料夾路徑。
 * @param {string} backupDir - 用於存放原始檔案備份的資料夾路徑。
 */
async function renameDuplicateFiles(groups, directory, backupDir) {
  console.log('\n--- 開始重新命名重複檔案 ---\n');

  // 確保備份資料夾存在
  try {
    await fs.mkdir(backupDir, { recursive: true });
  } catch (error) {
    console.error(`建立備份資料夾 "${backupDir}" 失敗: ${error.message}`);
    return;
  }

  for (const [baseName, fileList] of groups.entries()) {
    if (fileList.length <= 1) {
      continue;
    }

    // 延遲印出群組標題：只有在群組內真正有檔案被重新命名時才顯示
    let groupHeaderPrinted = false;
    const printGroupHeader = () => {
      if (!groupHeaderPrinted) {
        console.log(`處理群組 (基準名稱: ${baseName}):`);
        groupHeaderPrinted = true;
      }
    };


    // 計算群組中每個檔案的 MD5，並依 MD5 排序以確保重新命名順序固定不變
    const md5Map = new Map();
    for (const file of fileList) {
      const filePath = path.join(directory, file);
      try {
        const md5 = await computeMD5(filePath);
        md5Map.set(file, md5);
      } catch (e) {
        // 若無法計算 MD5（例如檔案已被移動），則以空字串作為佔位
        md5Map.set(file, '');
      }
    }
    fileList.sort((a, b) => (md5Map.get(a) || '').localeCompare(md5Map.get(b) || ''));

    // 決定哪個檔案應該作為基準檔案 (優先選擇沒有數字後綴的原始檔名)
    let fileToBecomeBase = fileList.find(f => f === baseName);
    if (!fileToBecomeBase) {
      // 如果找不到完全符合基準名稱的檔案，則預設使用排序後的第一個檔案
      fileToBecomeBase = fileList[0];
    }
    const otherFiles = fileList.filter(f => f !== fileToBecomeBase);

    // 步驟 1：備份群組中的所有檔案，並將它們重新命名為唯一的暫存檔名。
    // 這個步驟是為了防止在重新命名過程中，因檔名衝突而導致檔案被覆蓋。
    const tempFileMap = new Map();
    for (const file of fileList) {
      const oldPath = path.join(directory, file);
      const tempName = `${file}.${Date.now()}.${Math.random()}.tmp`;
      const tempPath = path.join(directory, tempName);

      try {
        const backupPath = path.join(backupDir, file);
        await fs.copyFile(oldPath, backupPath);
        console.log(`  - 已將 "${file}" 備份至 "${backupPath}"`);
        await fs.rename(oldPath, tempPath);
        tempFileMap.set(file, { tempPath, originalName: file });
      } catch (error) {
        console.error(`  - 為「${file}」建立暫存檔或備份時失敗: ${error.message}`);
      }
    }

    // 步驟 2：將被選為基準的檔案從其暫存檔名，重新命名為乾淨的基準檔名。
    const baseTempInfo = tempFileMap.get(fileToBecomeBase);
    let successfullyRenamedBase = false;
    if (baseTempInfo) {
      try {
        const idealPath = path.join(directory, baseName);
        if (baseTempInfo.originalName === baseName) {
          // 檔名已與目標相同，無需重新命名，直接將暫存檔還原即可
          await fs.rename(baseTempInfo.tempPath, idealPath);
          successfullyRenamedBase = true;
        } else {
          // 檢查目標路徑是否已經被其他檔案佔用
          const stats = await fs.stat(idealPath).catch(() => null);
          if (stats) {
            console.error(`  - 目標檔名 "${baseName}" 已被其他檔案使用，無法完成標準化命名。`);
            // 如果目標檔名已被佔用，則將此檔案也加入待處理列表，稍後會為其加上數字後綴。
            otherFiles.push(fileToBecomeBase);
            otherFiles.sort((a, b) => (md5Map.get(a) || '').localeCompare(md5Map.get(b) || ''));
          } else {
            await fs.rename(baseTempInfo.tempPath, idealPath);
            printGroupHeader();
            console.log(`  - 已將 "${baseTempInfo.originalName}" 重新命名為 "${baseName}" (作為主要檔案)`);
            successfullyRenamedBase = true;
          }
        }
      } catch (error) {
        printGroupHeader();
        console.error(`  - 將 "${baseTempInfo.originalName}" 重新命名為主要檔案時失敗: ${error.message}`);
        // 如果重新命名失敗，同樣將此檔案加入待處理列表。
        otherFiles.push(fileToBecomeBase);
        otherFiles.sort((a, b) => (md5Map.get(a) || '').localeCompare(md5Map.get(b) || ''));
      }
    }

    // 步驟 3：將群組中其餘的檔案重新命名，並依序加上數字後綴 (例如 _1, _2)。
    let counter = 1;
    const ext = path.extname(baseName);
    const name = path.basename(baseName, ext);

    for (const file of otherFiles) {
      const tempInfo = tempFileMap.get(file);
      if (!tempInfo) continue;

      let newName;
      let newPath;
      do {
        // 產生新的檔名，並檢查是否已存在，如果存在則增加計數器再試一次
        newName = `${name}_${counter++}${ext}`;
        newPath = path.join(directory, newName);
      } while (
        (await fs.access(newPath).then(() => true).catch(() => false))
      );

      if (tempInfo.originalName === newName) {
        // 檔名已與目標相同，無需重新命名，直接將暫存檔還原即可
        try {
          await fs.rename(tempInfo.tempPath, newPath);
        } catch (error) {
          console.error(`  - 還原「${tempInfo.originalName}」時失敗: ${error.message}`);
        }
        continue;
      }

      try {
        await fs.rename(tempInfo.tempPath, newPath);
        printGroupHeader();
        console.log(`  - 已將 "${tempInfo.originalName}" 重新命名為 "${newName}"`);
      } catch (error) {
        printGroupHeader();
        console.error(`  - 從暫存檔還原命名「${tempInfo.originalName}」時失敗: ${error.message}`);
      }
    }

    if (groupHeaderPrinted) {
      console.log('---');
    }
  }
  console.log('\n--- 重新命名完成 ---');
}

/**
 * 掃描指定資料夾，根據基準檔名找出可能的重複檔案群組。
 * 找到群組後，會先列出所有結果，然後根據使用者選擇決定是否執行重新命名。
 * @param {string} directory - 要掃描的資料夾路徑。
 * @param {boolean} enableRename - 是否啟用重新命名功能的布林值。
 * @param {string} backupDir - 備份資料夾路徑 (僅在 enableRename 為 true 時使用)。
 * @param {string[]} excludePrefixes - 要從掃描中排除的檔名開頭字串陣列。
 */
async function findAndProcessDuplicateFiles(directory, enableRename, backupDir, excludePrefixes) {
  try {
    console.log(`正在掃描資料夾: ${path.resolve(directory)}`);
    const files = await fs.readdir(directory);
    // 使用 Map 來儲存檔案群組，鍵為基準檔名，值為原始檔名陣列
    const groups = new Map();

    for (const file of files) {
      const fullPath = path.join(directory, file);
      const stats = await fs.stat(fullPath);
      if (!stats.isFile()) {
        continue;
      }
      // 根據使用者輸入的列表，排除特定開頭的檔案
      if (excludePrefixes.length > 0 && excludePrefixes.some(prefix => file.startsWith(prefix))) {
        continue;
      }
      // 取得檔案的基準名稱，並將其加入對應的群組
      const baseName = getBaseName(file);
      if (!groups.has(baseName)) {
        groups.set(baseName, []);
      }
      groups.get(baseName).push(file);
    }

    console.log('\n--- 掃描完成，找到以下可能的重複檔案群組 ---\n');
    let foundDuplicates = false;

    // 遍歷所有群組，只顯示檔案數量大於 1 的群組 (即真正的重複群組)
    for (const [baseName, fileList] of groups.entries()) {
      if (fileList.length > 1) {
        foundDuplicates = true;
        console.log(`群組 (基準名稱: ${baseName}):`);
        fileList.forEach(f => console.log(`  - ${f}`));
        console.log('---');
      }
    }

    if (!foundDuplicates) {
      console.log('在指定的資料夾中沒有找到符合條件的重複檔案。');
      return;
    }

    // 如果使用者選擇了啟用重新命名，則呼叫 renameDuplicateFiles 函式
    if (enableRename) {
      await renameDuplicateFiles(groups, directory, backupDir);
    } else {
      // 若未啟用重新命名，則顯示提示訊息
      console.log('\n提示：若要自動重新命名檔案，請在執行時選擇啟用重新命名功能。');
      console.log('重新命名會保留一個原始檔案，並將其他副本重新命名為 "檔名_1.jpg", "檔名_2.jpg" ... 的格式。');
    }

  } catch (error) {
    // 統一處理錯誤，特別是針對找不到資料夾的情況提供更友善的提示
    console.error('發生錯誤:', error.message);
    if (error.code === 'ENOENT') {
      console.error(`錯誤：找不到指定的資料夾 "${path.resolve(directory)}"`);
    }
  }
}

/**
 * 程式進入點 (Entry Point)。
 * 負責與使用者互動，透過命令行介面 (CLI) 取得必要的參數
 * (如目標路徑、是否重新命名等)，然後呼叫核心處理函式。
 */
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // 取得使用者輸入的參數
  const targetDirectory = await new Promise(resolve => rl.question('請輸入要掃描的資料夾路徑 (預設為當前目錄 \'./\'): ', resolve));
  const finalTargetDirectory = targetDirectory.trim() || '.';

  const enableRenameAnswer = await new Promise(resolve => rl.question('是否啟用重新命名功能? (y/n): ', resolve));
  const enableRename = enableRenameAnswer.toLowerCase() === 'y';

  // 只有在啟用重新命名時，才詢問備份路徑
  let backupDir = '';
  if (enableRename) {
    backupDir = await new Promise(resolve => rl.question('請輸入備份資料夾路徑: ', resolve));
    if (!backupDir.trim()) {
      console.log('啟用重新命名功能時，必須提供備份資料夾路徑。程式已中止。');
      rl.close();
      return;
    }
  }

  const excludePrefixesAnswer = await new Promise(resolve => rl.question('請輸入要排除的檔名開頭 (用逗號分隔，可留空): ', resolve));
  const excludePrefixes = excludePrefixesAnswer.trim()
    ? excludePrefixesAnswer.split(',').map(p => p.trim()).filter(p => p)
    : [];

  rl.close();

  // 使用收集到的參數，啟動檔案處理程序
  await findAndProcessDuplicateFiles(finalTargetDirectory, enableRename, backupDir.trim(), excludePrefixes);
}

// 執行主函式
main();
