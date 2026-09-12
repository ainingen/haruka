# data/

ゲームのデータ定義。コードに数値を埋め込まず、ここに置く。

| ファイル | 内容 |
|---|---|
| `parts.json` | チューニングパーツ（6カテゴリ、全46点） |
| `chassis.json` | 車両クラス4種のベース値と基準速度 |
| `courses.json` | コース（セクター配列）。3コース |
| `drivers.json` | ドライバー（技量、好みのバランス、安定性） |

これらを読んで走らせるのが `src/engine/race.js`。エンジンは I/O を持たないので、Node でもブラウザでも同じファイルが動く。
挙動テストは `npm test`（＝ `node --test src/engine/race.test.js`）。

`buildPerformance(loadout, ...)` の `loadout` は、パーツの配列でも
**スロット → パーツ の対応表**でも渡せる。同じスロットを2点が取り合っていると例外になる。

## parts.json

トップレベルは配列。各要素が1パーツ。

```json
{
  "id": "engine_intake_01",
  "name": "スポーツエアクリーナー",
  "category": "engine",
  "class_required": 1,
  "sponsor_tier": 0,
  "price": 18000,
  "durability": 100,
  "effects": { "power": 3, "throttle_response": 2 },
  "side_effects": { "low_end_torque": -1, "noise": 2 },
  "note": "吸わせれば上は伸びる。その分、下がスカスカになる。……"
}
```

### フィールド

| フィールド | 型 | 意味 |
|---|---|---|
| `id` | string | 一意の識別子。`{category}_{種別}_{連番2桁}`。変更しない（セーブデータが参照する） |
| `name` | string | 表示名。架空名のみ。実在ブランド・製品名は使わない |
| `category` | string | `engine` / `drivetrain` / `suspension` / `tire` / `brake` / `aero_weight` のいずれか |
| `slot` | string | 装着スロット。**装着の排他はカテゴリではなくスロット単位**。下記のスロット一覧を参照 |
| `replaces` | string[] | 省略可。`slot` に**加えて**占有するスロット。ユニット部品（カテゴリ丸ごとの置き換え）だけが持つ |
| `class_required` | 1〜5 | **装着**に必要なクラス（規定）。下記の対応表を参照 |
| `sponsor_tier` | 0〜4 | **入手**に必要なスポンサー段階。下記の対応表を参照 |
| `price` | number | 購入価格（円）。クラスが上がるほど桁が増える |
| `durability` | number | パーツ自体の耐久値。レースごとに消耗し、0 で故障。極端なパーツほど低い。**車両全体のリタイア率**は別キー `reliability` が担う |
| `effects` | object | このパーツを買う理由。パラメータ名 → 変化量 |
| `side_effects` | object | 代償。パラメータ名 → 変化量。**空にしない** |
| `note` | string | 父・大河のノートの書き込み。1〜3文。答えを与えず判断材料を示す |

### スロット一覧

同じスロットには1点しか装着できない。逆に、スロットが違えば同じカテゴリのパーツを併用できる
（例：フロントスタビとリアスタビは別スロットなので同時装着でき、`balance` が相殺される）。

| カテゴリ | スロット（この順に並べる） |
|---|---|
| `engine` | `intake` / `exhaust` / `ecu` / `cam` / `forced_induction` |
| `drivetrain` | `final` / `clutch` / `lsd` / `gearbox` |
| `suspension` | `damper` / `camber` / `toe` / `stabi_front` / `stabi_rear` |
| `tire` | `compound` |
| `brake` | `pad` / `rotor` / `caliper` / `bias` |
| `aero_weight` | `weight` / `aero` |

### replaces の仕様

ワークス系のようなユニット部品は、カテゴリのスロットをまとめて占有する。

- 占有スロット ＝ `slot` ＋ `replaces`。`replaces` に `slot` 自身は書かない。
- **ホームスロット（`slot`）は、占有するスロットのうちカテゴリ順で最も前のもの。** 迷う余地をなくすための決め事。
- 占有されたスロットには他のパーツを装着できない。画面では「（ワークス開発エンジンに含む）」のように表示する。

```json
{
  "id": "engine_works_01",
  "category": "engine",
  "slot": "intake",
  "replaces": ["exhaust", "ecu", "cam", "forced_induction"]
}
```

現在のユニット部品は4点。

| パーツ | 占有スロット |
|---|---|
| `engine_works_01` ワークス開発エンジン | engine 全5スロット |
| `drivetrain_works_01` ワークス駆動系 | drivetrain 全4スロット |
| `suspension_works_01` ワークス専用サスペンション | suspension 全5スロット |
| `brake_works_01` カーボンブレーキシステム | brake 全4スロット（`bias` を含むため、前後配分スライダーはこのパーツ単体でも解禁される） |

`tire_works_01` と `aero_weight_works_01` はユニットではない。前者はコンパウンドそのもの、
後者は空力パッケージであって軽量化ではない（`weight` を +6 する側なので、`weight` スロットは空けてある）。

### 符号の規約

- 値はすべて**そのパラメータの変化量**。正なら増える、負なら減る。
- `effects` と `side_effects` のどちらに置くかで有利／不利を表す。**符号で有利不利を表さない。**
  - 「増えると有利」なキー（`power` など）は、`effects` では正、`side_effects` では負になる。
  - 「増えると不利」なキー（`weight`、`drag` など）は、`effects` では負（例：軽量化 `"weight": -12`）、`side_effects` では正になる。
- レース計算側は `effects` と `side_effects` を区別せず**合算**してよい。区別は UI 表示（何を得て何を失うか）のためにある。
- 単位は無次元ポイント。目安はクラス1で ±1〜6、クラス5で ±10〜40。kg や PS への換算は表示側で行う。

### パラメータキー一覧（全26）

6カテゴリ共通。**ここにないキーを新設しない。** 必要なら先にこの表に追加し、意味と向きを定義する。

#### 出力・駆動

| キー | 意味 | 増えると | 主に効くセクター |
|---|---|---|---|
| `power` | エンジン出力（全域） | 有利 | 全域、特にストレート |
| `top_end_power` | 高回転域の伸び | 有利 | ストレート終端 |
| `low_end_torque` | 低回転トルク | 有利 | 低速コーナー脱出 |
| `throttle_response` | アクセルレスポンス。負ならラグ | 有利 | 低速コーナー脱出 |
| `acceleration` | 加速寄り（ギア比由来） | 有利 | 低速コーナー脱出、短いストレート |
| `top_speed` | 最高速寄り（ギア比由来） | 有利 | 長いストレート |
| `traction` | 駆動輪の機械的トラクション | 有利 | 低速コーナー脱出 |

#### 旋回・制動

| キー | 意味 | 増えると | 主に効くセクター |
|---|---|---|---|
| `cornering_grip` | 機械的なコーナリンググリップ | 有利 | 高速・低速コーナー |
| `braking` | 制動力 | 有利 | 低速コーナー進入 |
| `fade_resistance` | ブレーキの耐フェード性。フェードが始まる温度を押し上げる | 有利 | 周回後半の低速コーナー進入 |
| `turn_in` | 回頭性（切り始めの反応） | 有利 | 低速コーナー進入 |
| `stability` | 安定性（直進、高速域、挙動の収まり） | 有利 | 高速コーナー、ストレート（弱め） |
| `road_compliance` | 路面追従性（荒れた路面・縁石でのグリップ維持） | 有利 | 縁石を使うコーナー |
| `rigidity` | 剛性 | 有利 | 高速コーナー |
| `balance` | 前後バランス。**方向値**：正＝リア寄り（オーバー傾向）、負＝フロント寄り（アンダー傾向） | — | 全コーナー |

`balance` は装着パーツの合計を取り、**0 からの絶対値が大きいほど不利**。前後で相殺できる（フロントスタビ −3 ＋ リアスタビ +3 ＝ 0）。「単体の良し悪しではなく前後の相対関係」を表す唯一のキー。

#### 空力・重量

| キー | 意味 | 増えると | 主に効くセクター |
|---|---|---|---|
| `downforce` | ダウンフォース | 有利 | 高速コーナー |
| `drag` | 空気抵抗 | **不利** | ストレート |
| `weight` | 車重（ばね上） | **不利** | 全域 |
| `unsprung_weight` | ばね下重量（ホイール、ローター、キャリパー） | **不利** | 全域。計算ではコーナーで `weight` の **5倍相当**、直線では等倍 |

ばね下重量は路面追従性にも効くため、`weight` とは別キー `unsprung_weight` で持つ。レース計算ではコーナーで `weight + 5 × unsprung_weight`、直線では `weight + unsprung_weight`（直線ではばね下も単なる質量）として合算する（`src/engine/race.js`）。ホイール・ローター・キャリパーの重量変化は必ず `unsprung_weight` に置き、`weight` に混ぜない。

#### 消耗・熱・信頼性

| キー | 意味 | 増えると | 備考 |
|---|---|---|---|
| `warmup` | 温まりの早さ（タイヤ・ブレーキ共通） | 有利 | 予選・スタート直後に効く。負なら冷間時に効かない |
| `tire_wear` | タイヤ摩耗率 | **不利** | 耐久で効く。ピット回数を左右する |
| `heat` | 発熱 | **不利** | タイヤ摩耗とブレーキ温度の上昇を早める。負なら放熱が良い（ブレーキのみ） |
| `fuel_consumption` | 燃料消費率 | **不利** | 耐久で効く |
| `reliability` | 車両の信頼性 | 有利 | 負が積み重なるほどリタイア率が上がる |

#### その他

| キー | 意味 | 増えると | 備考 |
|---|---|---|---|
| `noise` | 騒音 | **不利** | 音量規定のあるイベントで出走不可になりうる |
| `driver_demand` | 要求される技量 | **不利** | ドライバー技量が満たないとミス率が上がる。技量が上回れば実害なし |

### class_required と sponsor_tier の対応表

2つは**独立した軸**で、装着には両方を満たす必要がある。

| クラス | 場 | 車両 | 解禁範囲（`class_required`） |
|---|---|---|---|
| 1 | 走行会・草レース | ハッチバック | 純正流用、軽い吸排気、タイヤ、ギア比 |
| 2 | 地方選手権 | セダン | 車高調、ブレーキ、軽量化 |
| 3 | 全国耐久 | セダン〜GT | エンジン内部、LSD、エアロキット |
| 4 | GT下位 | GT | 過給機、本格空力、大幅軽量化 |
| 5 | トップカテゴリー | GT / フォーミュラ | 開発パーツ、専用設計 |

| 段階 | スポンサー | 入手できるもの（`sponsor_tier`） |
|---|---|---|
| 0 | なし（自腹） | 中古パーツ、純正流用 |
| 1 | 地元（整備工場、飲食店） | 社外パーツ |
| 2 | 地方チェーン | ワンオフ、セミワークス級 |
| 3 | 全国企業（架空名） | 開発パーツ |
| 4 | 大手メーカー（架空名） | ワークス級、専用設計 |

典型的には `sponsor_tier = class_required - 1` だが、**意図的にずらしてある**パーツがある。

- `sponsor_tier < class_required - 1`：先に手に入るが、規定で装着できない（例：`drivetrain_lsd_01` は tier 1 で買えるが class 3 まで付かない）。「持っているのに使えない」が昇格の動機になる。
- `sponsor_tier` が高いほど `price` も上がる。資金と解禁の両方で段階化する。

### パーツを追加するときのルール

1. **`side_effects` を必ず1つ以上持たせる。** 副作用が思いつかないパーツは設計が終わっていない。現実の理屈から探す（出力↑なら熱と耐久、グリップ↑なら摩耗、軽量化なら剛性と信頼性）。
2. **単純上位を作らない。** 同じ種別の上位パーツは、効果と価格が大きくなるのと同時に副作用も大きくなる。上位を買えば下位が要らなくなる、という関係にしない。
3. **キーは上の一覧から選ぶ。** 表記ゆれ（`grip` / `cornering_grip`、`wear` / `tire_wear`）を作らない。新しいキーが本当に必要なら、先に一覧へ追加してから使う。
4. **コースによって最適解が変わるか確認する。** ストレート主体のコースと低速コーナー主体のコースで、そのパーツの評価が逆転する余地があるか。逆転しないなら副作用が弱い。
5. `note` は大河の口調で。命令形と短文。「〜なら〜だ」「〜を数えろ」「〜してから決めろ」。**答えを書かない。** 何を見て判断するかを書く。
6. クラス5のパーツは、父のノートに記述が尽きる領域。`note` は「俺は知らん」「自分で書け」で終わる書き方にし、ハルカ自身の書き込みへ切り替わる余地を残す。
7. `id` は一度公開したら変えない。

### parts.json に含めていないもの

以下は「パーツ」ではなく**セッティング画面の連続値**として扱う想定。効果は上の同じキー語彙で表現する。

- **空気圧** — `warmup` と `tire_wear` に効く。高いと温まりは早いが終盤でタレる。ハルカの領分。
- **ブレーキ前後配分の数値** — `brake_bias_01` を装着すると調整可能になる。数値そのものは走行前に決める。
  `brake_bias_01` は性能パーツではなく、セッティング画面で前後ブレーキ配分の連続値スライダーを解禁するパーツ。
  スライダーは実装済み（`src/engine/race.js` の `SETTINGS.brake_bias`）。配分は `balance` にも効くので、
  アンダーな車を配分で釣り合わせることができる＝基準の 60% が常に最適ではない。
- **減衰力・車高の数値** — 車高調装着で調整可能になる。

## chassis.json

車両クラスごとのベース。キーは `hatchback` / `sedan` / `gt` / `formula`。

| フィールド | 意味 |
|---|---|
| `base_speed` | セクター種別ごとの基準速度（m/s）。`straight` / `fast_corner` / `slow_corner` |
| `base` | 性能ポイントの初期値。parts.json と同じ語彙。書いていないキーは 0 |
| `display` | 画面表示と換算のための実寸。`length_mm` / `wheelbase_mm` / `ride_height_mm` / `weight_kg` / `power_ps` |

`display` は寸法線の数値と、ポイント → kg・ps の換算基準に使う（換算は表示側で行う）。
`ride_height_mm` は車高スライダーの基準値でもあり、そこから −40〜+20mm の範囲で動かせる。

性能ポイントは「その車種の基準からの差分」。クラス間の速さの差は `base_speed` が担い、
パーツのポイントは全クラスで同じ意味を持つ。

## courses.json

配列。各コースは `sectors` にセクターを走行順で並べる。

```json
{ "type": "straight" | "fast_corner" | "slow_corner", "length": 1200 }
```

`length` は m。`profile`（`straight` / `corner` / `balanced`）は説明用のタグで、計算には使わない。
セクター種別ごとに効く性能キーは `src/engine/race.js` の `WEIGHTS.sector` を見る。

## drivers.json

| フィールド | 意味 |
|---|---|
| `skill` | 技量 0〜100。全セクターの時間に係数として掛かる。`driver_demand` の高い車ほど低 skill の損が大きい。成長するので初期値 |
| `preferred_balance` | 好みの前後バランス（`balance` と同じ向き。正＝オーバー寄り）。車両の `balance` がここからズレるほど遅くなる。**0 が最適ではない** |
| `consistency` | 周回タイムのばらつきの小ささ 0〜100。乱数ありのレースでのみ効く |

## 連続値セッティング

パーツとは別に、走行前に決める数値。定義は `src/engine/race.js` の `SETTINGS`。
`buildPerformance(loadout, driver, chassis, settings)` の第4引数で渡すと、
パーツの `effects` / `side_effects` と同じ語彙・同じ向きの差分として合算される。

| キー | 範囲 | 解禁条件 | 効果と代償 |
|---|---|---|---|
| `tire_pressure` | 1.6〜2.6 bar（基準 2.1） | 常時 | 高いほど `warmup` が上がるが `tire_wear` も増える。基準から離れるほど `cornering_grip` が落ちる（接地形状） |
| `ride_height` | 基準 −40〜+20 mm | 車高調系を装着 | 下げると `downforce` `cornering_grip` が上がり `drag` が減るが、`road_compliance` を失う |
| `brake_bias` | 50〜70 %前（基準 60） | `brake_bias_01` または `brake_works_01` を装着 | 後ろへ寄せると `turn_in` と `balance` が上がり `stability` を失う。どちらに振っても `braking` は二次で落ちる |

**基準値が常に最適ではない。** 空気圧はレース長で、車高はコース特性で、ブレーキ配分は車の `balance` と
ドライバーの `preferred_balance` との関係で最適点が動く。

## レース計算で使っているキー・いないキー

`src/engine/race.js` が現時点で参照するキーと、まだ計算に入っていないキー。
未使用のキーもデータには残す（UI 表示と将来の計算のため）。

| 扱い | キー |
|---|---|
| セクター速度 | `power` `top_speed` `top_end_power` `drag` `downforce` `cornering_grip` `stability` `rigidity` `road_compliance` `acceleration` `traction` `braking` `turn_in` `low_end_torque` `throttle_response` `weight` `unsprung_weight` `balance`（`preferred_balance` とのズレ） |
| タイヤ状態 | `tire_wear` `heat` `warmup` |
| ブレーキ温度 | `fade_resistance` `heat`。低速コーナー比率の高いコースで温度が溜まり、閾値を超えると `braking` が減衰 |
| ドライバー係数 | `driver_demand` |
| 連続値セッティング | `tire_pressure` `ride_height` `brake_bias`（上表。合算後は通常のキーと区別されない） |
| リタイア判定 | `reliability` |
| **未使用** | `fuel_consumption`（耐久のピット戦略）、`noise`（音量規定による出走可否）。パーツの `durability` もレース間の消耗として別途扱う予定 |
