---
name: api-stability
description: OSS リポジトリの SemVer 遵守度と破壊的変更 (Breaking Change) の頻度を評価するスキル。API 安定性監査を実行するときに読み込む。
allowed-tools: fetch_github, read_file, write_file
---

# API 安定性スキル

## このスキルを使うタイミング

- `api-stability` サブエージェントが「このライブラリを本番で使って壊れないか」を判定するとき
- メジャーバージョンアップで公開 API がどれくらい変わるかを見積もるとき
- 過去の Breaking Change 率から将来の変更を予測するとき

## SemVer カテゴリと判定

| バージョン | SemVer 状態 | BC の許容度 |
|---|---|---|
| `>= 1.0.0` | `stable` | MAJOR bump 時のみ許容。MINOR / PATCH で BC があればバグ |
| `>= 0.1.0 < 1.0.0` | `pre-1.0` | MINOR bump で BC が入ることは仕様範囲内。採用前に覚悟する必要あり |
| `< 0.1.0` | `experimental` | あらゆる bump で BC があり得る。プロダクション採用は要注意 |
| `0.0.0-*` (pre-release tag) | `unstable` | canary / alpha / beta。長期採用には向かない |

## 破壊的変更の検出方法

1. **CHANGELOG を読む**: `CHANGELOG.md` の "Breaking Changes" セクション or `BREAKING:` を含むコミットメッセージ
2. **MAJOR bump の頻度を数える**: `git log --tags` でタグ履歴を取り、MAJOR の発生間隔を計算
3. **MINOR に紛れた BC を検出**: pre-1.0 では MINOR に BC が入る。CHANGELOG 記述と git diff でクロスチェック
4. **deprecation notice を数える**: 直近のリリースで `@deprecated` アノテーションや "deprecated" の記述が増えていれば、次の MAJOR で削除される前兆

## 90 日 BC カウントの計算

- 直近 90 日の CHANGELOG エントリを対象
- "Breaking" / "BC" / "removed" / "renamed" キーワードを含む行を候補にする
- 候補をまとめて 1 つの BC エントリ (同一リリース内の関連変更は集約)
- **コメント・ドキュメントの変更は除外** (実行時 API に影響するものだけを数える)

## NG 例

- **"pre-1.0 だから BC は気にしない" と切り捨てる**: pre-1.0 でも BC の頻度が多いほど採用コストは高い。数値で報告する
- **SemVer 違反を黙って見逃す**: `1.x.y` で MINOR bump に BC が入っていたら `semver_violations` に明記する。これは公開契約違反
- **CHANGELOG に頼りすぎる**: 書き忘れた BC もあり得る。git diff で一次情報を見る習慣を持つ
- **BC 数 = 悪い、0 = 良い と単純化する**: BC が 0 でも機能追加が無ければ `abandoned` 寄り。maintenance スキルの指標と合わせて読む

## 出力契約 (`/raw/api-stability/result.json`)

```json
{
  "semver": "pre-1.0",
  "current_version": "0.8.3",
  "breaking_changes_last_90d": 3,
  "semver_violations": [],
  "deprecation_warnings_count": 2,
  "notes": "CHANGELOG から breaking change 3 件を抽出。いずれも MINOR bump (0.6→0.7, 0.7→0.8) で発生しており pre-1.0 として妥当"
}
```

`semver_violations` は**公開契約違反だけ**をリストアップする。stable (>= 1.0.0) で PATCH/MINOR に BC が紛れ込んでいたら必ず記録する。pre-1.0 の BC は spec 範囲内なので `semver_violations` には入れない。
