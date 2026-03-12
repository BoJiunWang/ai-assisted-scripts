# 檔案同步與重複檢查工具 (File Sync & Duplicate Checker)

這是一個以 Node.js 撰寫的強力檔案比對與同步工具。與一般工具不同，它重點在於**「內容比對」**而非檔名，確保即使檔名不同也能準確識別重複檔案。

## 功能特色

- **內容導向比對**：不依賴檔名，透過雜湊值（Hash）判定檔案內容是否完全相同。
- **高效分層驗證**：
  1. **快速指紋**：對檔案內容進行抽樣，初步篩選。
  2. **MD5 驗證**：對候選群組進行深度比對。
  3. **SHA256 最終確認**：僅在 `find-duplicates` 模式下進行最嚴謹的檢查。
- **智慧快取系統**：
  - 每個資料夾獨立快取 (`.duplicate-hash-cache.json`)。
  - 具備快取簽章（校驗檔案大小、修改時間等），降低誤命中風險。
  - 支援「可攜式快取重用」，提升掃描速度。
- **多功能子命令**：
  - `find-duplicates`：找出所有重複內容的檔案。
  - `find-missing`：比對資料夾間的內容差異（A 有 B 沒有）。
  - `sync-missing`：安全同步缺失檔案（僅新增不刪除）。
  - `make-cache`：預先建立索引以加速後續分析。
- **安全同步機制**：
  - `sync-missing` 提供預覽模式（Dry-run）。
  - 自動處理衝突：同路徑但內容不同時，會自動加上流水號後綴，不覆蓋原有檔案。
- **穩定輸出**：結果經過排序，便於進行 diff 或自動化腳本處理。

## 環境需求

- Node.js 16+ (建議版本 18 或以上)
- 支援多平台 (macOS / Linux / Windows)

## 如何使用

1. 打開您的終端機 (Terminal) 或命令提示字元 (Command Prompt)。
2. 使用 `node` 執行主程式（請確保路徑正確）：

```bash
node find-duplicate-files.js <子命令> <資料夾1> [資料夾2 ...] [--apply]
```

### 可用子命令與範例

#### 1. 尋找重複檔案 (`find-duplicates`)
找出指定資料夾內所有內容重複的檔案群組。
```bash
node find-duplicate-files.js find-duplicates ./path/A ./path/B
```

#### 2. 找出缺失內容 (`find-missing`)
列出不同資料夾之間的內容差異，例如「A 資料夾有，但 B 資料夾沒有」的檔案。
```bash
node find-duplicate-files.js find-missing ./path/A ./path/B
```

#### 3. 同步缺失內容 (`sync-missing`)
將缺失的內容互相補齊。預設為預覽模式，確認後可執行 `--apply`。
```bash
# 預覽同步結果
node find-duplicate-files.js sync-missing ./path/A ./path/B

# 實際執行同步
node find-duplicate-files.js sync-missing ./path/A ./path/B --apply
```

#### 4. 預建快取 (`make-cache`)
預先掃描並建立索引快取，大幅提升後續執行上述指令的速度。
```bash
node find-duplicate-files.js make-cache ./path/A ./path/B
```

## 注意事項

- **路徑空白**：若資料夾路徑包含空白，請務必使用雙引號括起來。
- **預防性同步**：執行 `sync-missing --apply` 會實際寫入檔案，強烈建議先執行不帶 `--apply` 的預覽模式。
- **資料安全**：本工具**完全不會刪除任何原始檔案**，所有操作皆為讀取、比對或複製。
- **快取機制**：首次掃描大型資料夾可能較耗時，建立快取後第二次執行將會非常快速。

---

## 授權條款 (License)

本專案採用 MIT License 授權。這表示您可以自由地使用、複製、修改、合併、發布、散布、再授權及/或銷售本軟體的副本，只要在所有副本或主要部分中包含原始的版權和授權聲明即可。

## 免責聲明 (Disclaimer)

本軟體係依「現況」提供，不含任何明示或暗示的保證，包括但不限於可商業化、適用於特定目的及未侵害他人權利之保證。

在任何情況下，作者或版權持有人皆不對任何因使用本軟體或與本軟體相關的交易所引發的任何索賠、損害或其他責任（無論是契約、侵權或其他形式）負責。

**強烈建議您在執行「sync-missing」功能前，務必先行備份您的重要資料。使用者需對任何因操作本軟體而導致的資料遺失或損壞自行承擔全部責任。**

## 作者 (Author)

此程式碼由 OpenAI 的大型語言模型 Codex 產生與協助開發。
