---
name: security
description: OSS リポジトリの既知脆弱性 (OSV / GHSA) を照合し、重大度と影響範囲を分類するスキル。セキュリティ監査を実行するときに読み込む。
allowed-tools: query_osv, fetch_github, read_file, write_file
---

# セキュリティ監査スキル

## このスキルを使うタイミング

- `security-auditor` サブエージェントが対象 OSS の既知脆弱性を照合するとき
- 特定のパッケージバージョンに紐づく CVE / GHSA を抽出するとき
- 脆弱性の重大度・影響範囲を判定して report に出すとき

## 調査フロー

1. **対象の package name + version を確定する**: `fetch_github(owner, repo)` で `default_branch` と `package.json` を確認。npm パッケージなら npm のメインパッケージ名、monorepo なら主要パッケージを優先
2. **OSV API で照合する**: `query_osv(packageName, version, ecosystem)` を呼ぶ。ecosystem は `"npm"` / `"PyPI"` / `"Go"` など OSV が認める値
3. **マッチした脆弱性を重大度で分類する**: 下表の基準で `critical / high / medium / low / unknown` に振る
4. **結果を `/raw/security/result.json` に書き出す**

## 重大度判定の基準

| `severity` | CVSS v3 (ある場合) | 判断軸 |
|---|---|---|
| `critical` | 9.0 - 10.0 | 認証不要の RCE / SQL injection / auth bypass。即時パッチが必要 |
| `high` | 7.0 - 8.9 | 認証要だが権限昇格あり、またはデータ漏洩経路が明確 |
| `medium` | 4.0 - 6.9 | 条件付き DoS、情報開示 (影響範囲限定) |
| `low` | 0.1 - 3.9 | レアな条件下でのみ発火、実害が限定的 |
| `unknown` | CVSS 未設定 | OSV に `severity` 情報が無い場合。**勝手に当てない** |

**CVSS が無い場合に LLM が印象で critical を付けない**。`unknown` のままにし、`notes` に「CVSS 未設定、GHSA の説明文のみ」と明記する。

## NG 例

- **dev dependencies の脆弱性を production 同等に扱う**: `devDependencies` の脆弱性は影響範囲が限定的なことが多い。`affected_scope: "dev"` として明示し、`severity` を過剰に上げない
- **古い CVE を最新として報告する**: OSV のエントリには `published` / `modified` 日時がある。監査時点から古すぎる CVE (既に修正済みリリースがある) は `patched_in` にバージョンを書き、「現行バージョンでは解消済み」なら findings から外す
- **version range を単一バージョンとして扱う**: OSV の `affected.ranges` は範囲で表現される。`>=1.0.0 <1.2.3` のような範囲をそのまま報告に乗せる。「v1.0 に脆弱性あり」のような単一表記に丸めない
- **query_osv の結果を生で貼り付ける**: OSV のレスポンスは冗長。必要なフィールド (id, severity, affected.ranges, summary, published) だけ抽出し、それ以外はドロップする

## 出力契約 (`/raw/security/result.json`)

```json
{
  "known_vulnerabilities": [
    {
      "id": "GHSA-xxxx-yyyy-zzzz",
      "severity": "high",
      "affected_versions": ">=1.0.0 <1.2.3",
      "patched_in": "1.2.3",
      "summary": "Prototype pollution via ...",
      "affected_scope": "production"
    }
  ],
  "osv_batch_queries": 12,
  "notes": "monorepo のメインパッケージ foo-lib@1.1.0 に対して OSV を照合。dev dependencies は対象外"
}
```

- `known_vulnerabilities: []` (空配列) と「調査していない」は区別する。調査した結果 0 件なら `osv_batch_queries` を正の数にする。未調査なら `notes` に理由を書く
- 大量ヒット時は `critical` / `high` を優先し、`low` は件数のみ集計して `summary` を省略してよい
