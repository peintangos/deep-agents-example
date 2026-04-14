---
name: community
description: OSS リポジトリのコミュニティ採用状況 (star / contributor 分散 / 依存 downstream) を測定するスキル。コミュニティ採用監査を実行するときに読み込む。
allowed-tools: fetch_github, read_file, write_file
---

# コミュニティ採用状況スキル

## このスキルを使うタイミング

- `community-adoption` サブエージェントが対象 OSS の「普及度」「将来性」を評価するとき
- 類似 OSS との比較で採用判断を下すとき
- 単一メンテナー依存 (バストラック) リスクを検出するとき

## 主要指標

### 1. Star 数 (ポピュラリティ)

| stars | 採用状況 |
|---|---|
| `>= 10000` | メインストリーム。情報・ナレッジが豊富 |
| `1000 - 9999` | 成熟。業務採用事例もある |
| `100 - 999` | ニッチだが実用段階 |
| `< 100` | 新興 / 実験的 |

**star はラグ指標**: 過去の人気を反映するので、**最近 90 日の増加率**も併記する。

### 2. Contributor 分散

```
bus_factor = トップ contributor のコミット割合 (直近 90 日)
```

- `< 30%` → 健全 (複数のコアメンテナーがいる)
- `30% - 60%` → 中程度 (1〜2 人が主導)
- `>= 60%` → **バストラック注意** (1 人に集中しており、その人が離脱すると止まる)

### 3. Downstream dependents

- npm なら `npmjs.com` の dependents 数
- GitHub なら `used-by` カウント
- **絶対数より増加率**: 直近 6 ヶ月で増えている / 減っている / 横ばい のトレンドを書く

### 4. コミュニケーションチャンネル

- Discord / Slack / GitHub Discussions / Matrix など公式チャンネルの有無
- 「公式フォーラム無し + Issue trackerでのやり取りのみ」は小さなコミュニティ

## 調査フロー

1. `fetch_github(owner, repo)` で `stargazers_count` / `forks_count` / `subscribers_count`
2. contributors API で直近 90 日のコミット割合を計算し bus_factor を導出
3. `package.json` から npm パッケージ名を取得し、npm dependents 数を lookup (GitHub のみの場合は used-by カウント)
4. README / repository description でコミュニティチャンネルを確認

## NG 例

- **star 数だけで "人気 = 健全" と判定する**: star は過去指標。止まっている大 star リポジトリ (star は多いが開発は停滞) を見逃す
- **bus_factor を無視する**: contributor 1 人に依存しているプロジェクトは、その 1 人が離脱したら即 `abandoned` になる。採用判断では必ず bus_factor を記載
- **downstream をスルーする**: 自分達が使おうとしている用途 (例: npm パッケージとして) での依存数が重要。GitHub だけ見て npm を見ないとミスリードする
- **コミュニティチャンネルを「あるなら良し」で評価**: 活発度を見る。過去半年で投稿 0 の Discord はあっても意味がない

## 出力契約 (`/raw/community/result.json`)

```json
{
  "stars": 12000,
  "stars_growth_90d_pct": 8.5,
  "contributors_total": 150,
  "recent_contributors_30d": 22,
  "bus_factor_pct": 32,
  "downstream_dependents": 450,
  "community_channels": ["GitHub Discussions", "Discord (active)"],
  "notes": "star は 1 万超えだが直近 90 日の伸びは 8.5% と鈍化傾向。bus_factor は 32% で健全ライン"
}
```

`bus_factor_pct` は **トップ 1 人のコミット割合**。30% 超なら `notes` でリスクとして言及する。50% 超なら critic フェーズで warning を誘発する想定。
