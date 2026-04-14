---
name: maintenance
description: OSS リポジトリのメンテナンス健全性 (リリース頻度・Issue 対応速度・放置 PR) を定量的に評価するスキル。メンテナンス監査を実行するときに読み込む。
allowed-tools: fetch_github, read_file, write_file
---

# メンテナンス健全性スキル

## このスキルを使うタイミング

- `maintenance-health` サブエージェントが対象 OSS が「生きているか」「死んでいるか」を判定するとき
- 採用判断で「向こう 6 ヶ月この OSS を使い続けて大丈夫か」を聞かれたとき
- 定期的な監査で前回からの劣化を検出したいとき

## 指標と判定基準

| 指標 | `healthy` | `stagnant` | `abandoned` |
|---|---|---|---|
| **リリース頻度** (直近 90 日) | 2 回以上 | 1 回または長期間空き | 0 回かつ 180 日以上空き |
| **Issue 応答中央値** (直近 30 日) | 72 時間以内 | 72〜336 時間 | 返事なし or 336 時間超 |
| **open issue 数の trend** | 横ばい or 減少 | 緩やかに増加 | 急増 (月 +20% 以上) |
| **contributor 分散** | 3 人以上が active | 1〜2 人に集中 | メインのみ / 完全停止 |

4 指標のうち **2 つ以上が `stagnant` 以下** なら全体を `stagnant`、**3 つ以上が `abandoned`** なら `abandoned` と判定する。単一指標だけで結論を出さない。

## 調査フロー

1. `fetch_github(owner, repo)` で基本メタデータ (stars / open_issues_count / pushed_at / default_branch)
2. releases API で直近 90 日のリリース数を数える (`getReleases` のようなヘルパ経由)
3. issues API で直近 30 件の Issue の作成時刻と初回返信時刻を比較し、中央値を計算
4. contributors API で直近 30 日の active contributor 数を数える
5. 上の表に当てはめて `health` を決定

## NG 例

- **Star 数だけで判定する**: star が多くても開発が止まっているリポジトリは存在する。star は採用状況スキル (`community`) の指標であり、**メンテナンス健全性とは独立**
- **最終コミット日時 (`pushed_at`) だけで判定する**: `pushed_at` は branch への push だけで更新されるので、タグ・リリースの有無は別指標として扱う
- **Issue 応答速度を平均値で計算する**: 外れ値 (極端に古い Issue) に引っ張られる。必ず中央値を使う
- **`health: "abandoned"` を単独指標で付ける**: 1 ヶ月無言だっただけで abandoned にしない。メンテナーが休暇中なだけの可能性もあるので、**4 指標のうち 3 つ以上が崩れている**ことを条件にする

## 出力契約 (`/raw/maintenance/result.json`)

```json
{
  "release_cadence_days": 14,
  "open_issue_count": 120,
  "issue_response_median_hours": 36,
  "active_contributors_30d": 8,
  "health": "healthy",
  "notes": "直近 90 日で 6 リリース、Issue 中央値 36 時間。contributor 8 人 active"
}
```

`release_cadence_days` は「直近 2 回のリリース間隔」ではなく「直近 90 日の平均」で計算する。単発のリリースが長く続いた後に急に 2 本出た場合でも平均化される。
