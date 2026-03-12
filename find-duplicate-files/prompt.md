
```text
請接手這份 Node.js 專案，目標是維護「檔案比對與同步工具」。

目前專案檔案：
1) /Users/ivan/find-duplicate-files/find-duplicate-files.js
2) /Users/ivan/find-duplicate-files/hash-cache-core.js
3) /Users/ivan/find-duplicate-files/build-md5-cache.js
4) /Users/ivan/find-duplicate-files/README.md

目前 CLI 子命令（在 find-duplicate-files.js）：
- find-duplicates
- find-missing
- sync-missing
- make-cache

核心行為：
- 內容比對不是看檔名
- 分層驗證流程：快速指紋 -> md5 -> sha256
- 每個資料夾獨立快取：<folder>/.duplicate-hash-cache.json
- 遞迴掃描所有子資料夾檔案
- 結果有排序（穩定輸出方便 diff）
- 重複輸入資料夾會去重
- exit code 規則：0=成功、2=參數/輸入錯誤、1=執行期錯誤

目前已確認/調整的重要規則：

find-missing：
- 產生 A有B沒有 的差異結果（有向配對）
- 需要至少 2 個資料夾；不足時為參數錯誤並 exit code 2
- 若剛好 2 個資料夾且有差異，會提示先 sync-missing dry-run 再 --apply

sync-missing（重要）：
- 多資料夾互相同步（每個資料夾輪流當 source）
- 預設 dry-run，只預覽；加 --apply 才真正複製
- 不刪除檔案
- 同路徑不同內容視為衝突，跳過不覆蓋
- 缺失判定改為「對應子資料夾」：只在 target 與 source 相同相對目錄中比對內容
  - target 在其他子資料夾有相同內容，不算已存在，仍會補到對應子資料夾

SHA256 驗證策略（重要）：
- 為避免快取簽章碰撞誤判，最終 SHA256 驗證預設不信任磁碟 persistent cache
- 同一輪執行仍使用記憶體 runtime cache，避免同檔重算
- 目標是：維持低 I/O 的分層流程，同時確保最終確認正確性

快取簽章策略（已更新）：
- 快取簽章使用 `size + mtimeMs + ctimeMs`，降低 stale cache 誤命中風險
- `make-cache` 預設採可攜快取重用：嚴格簽章不命中時，會以 `size + 快速指紋` 驗證後重用既有 md5
- `make-cache` 採分批 checkpoint 存檔（原子寫入 + rename），不需等全檔案完成才落盤
- checkpoint 預設：每 200 筆變更或每 5 秒；可用 `DUP_CACHE_CHECKPOINT_FILES` / `DUP_CACHE_CHECKPOINT_MS` 調整

sync-missing 收斂策略（已更新）：
- 在 `--apply` 複製成功後，會即時更新記憶體索引（`fileIndex` 與 target 指紋分組）
- 目的：降低多資料夾同步時「需要再跑一輪才收斂」的情況

近期已完成的風險修正：
- `sync-missing --apply` 複製成功後，會同步回寫 target 的 `scan.seenRelPaths`，避免結尾 prune stale cache 清掉當輪新路徑
- runtime hash cache（md5/sha256）命中前會先驗證目前簽章；檔案若在執行中被改動，會自動失效重算

find-duplicates：
- 顯示重複群組，且有互動刪除模式
- 同一個輸入資料夾在輸出中有固定背景色標籤，方便視覺辨識來源

交接建議：
1) 讀 README 與上述三支 js
2) 快速檢查流程一致性與潛在風險
3) 再依下一個需求直接修改程式
```
