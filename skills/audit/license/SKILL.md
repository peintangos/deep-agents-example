---
name: license
description: OSS リポジトリのメインライセンスを特定し、商用利用制約・依存互換性・NG ライセンスの検出までを行うスキル。ライセンス監査を実行するときに読み込む。
allowed-tools: fetch_github, read_file, write_file
---

# ライセンス監査スキル

## このスキルを使うタイミング

- `license-analyzer` サブエージェントが対象 OSS のメインライセンスを確定させるとき
- 特殊ライセンス (Elastic License 2.0 / SSPL / BSL) が疑われるとき
- 依存関係に copyleft (GPL 系) ライセンスが混入していないか確認するとき

## 一次情報の優先順位

1. **GitHub リポジトリメタデータ**: `fetch_github(owner, repo)` → `license.spdx_id` が最優先
2. **リポジトリ直下の `LICENSE` / `LICENSE.md`**: SPDX ID で判別できない場合の根拠文
3. **`package.json` の `license` フィールド**: npm パッケージとして公開されている場合の secondary
4. **README の "License" セクション**: 最終手段 (本文のみで一次情報と呼べないケースもある)

**推測禁止**: 上記のいずれにも書かれていない場合は `spdx_id: "unknown"` と明示する。`LICENSE` ファイルの本文から LLM が勝手に SPDX を当てるのは避ける (誤判定のコストが高い)。

## 商用利用制約の判定基準

| ライセンス | `commercial_use` | 備考 |
|---|---|---|
| `MIT` / `Apache-2.0` / `BSD-*` / `ISC` / `MPL-2.0` | `allowed` | 一般的な permissive |
| `LGPL-*` | `allowed` | ただし動的リンクが条件 |
| `GPL-*` / `AGPL-*` | `restricted` | コピーレフトが波及。SaaS 提供で AGPL はほぼ致命 |
| `Elastic-2.0` / `BSL-1.1` / `SSPL-1.0` | `restricted` | **SaaS 再配布に制約あり**。`compatibility_concerns` に明記必須 |
| 独自ライセンス / CC 系 | `unknown` | 法務レビューが必要なので勝手に `allowed` と書かない |

## NG 例 (ハマりやすいミス)

- **BSL を `allowed` と判定する**: BSL は Change Date を迎えるまで一部用途が禁止される。Change Date 付きは必ず `restricted` と書き、`notes` に Change Date を載せる
- **`spdx_id` と `license_name` が食い違う**: `spdx_id` は機械可読な識別子、`license_name` は人間可読の正式名称。例えば `"Apache-2.0"` / `"Apache License 2.0"` のように両方そろえる。片方だけに「Apache License v2」のような揺らぎ表記を入れない
- **サブライブラリ (依存関係) のライセンスを無視する**: メインが MIT でも `package.json` の dependencies に GPL が混ざっていたら `compatibility_concerns` に書く。**メイン 1 つだけで判断を終わらせない**
- **LLM による本文の意訳**: LICENSE ファイルの本文を要約して `commercial_use: allowed` と書くのは禁止。必ず公式の SPDX 定義に当てる

## 出力契約 (`/raw/license/result.json`)

```json
{
  "spdx_id": "Elastic-2.0",
  "license_name": "Elastic License 2.0",
  "commercial_use": "restricted",
  "compatibility_concerns": [
    "SaaS 配布時の再配布制約あり",
    "依存ライブラリ foo-lib が GPL-3.0 で再配布制約が連鎖"
  ],
  "notes": "GitHub メタデータ license.spdx_id から取得。LICENSE ファイルで Change Date 2026-01-01 を確認"
}
```

`compatibility_concerns` は「実利に影響する点だけ」を箇条書きにする。汎用的な注意事項 (コピーレフトは波及します等) は入れない — 対象 OSS 固有の事実だけ。
