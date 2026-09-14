/**
 * お金・購入・売却・消耗・修理（docs/設計/経済とシーズン.md）。
 *
 * 数値はすべて data/economy.json（呼び出し側が読んで渡す）。ここは純関数だけ。
 * state を受け取る関数は **新しい state を返し、元は変えない。**
 */

// ---------------------------------------------------------------------------
// 購入・売却
// ---------------------------------------------------------------------------

/** 所有しているか。 */
export const owns = (state, partId) => state.owned.includes(partId);

/**
 * 買えないなら理由（文字列）、買えるなら null。
 * 規定・スポンサー段階・資金の順に見る。所有済みは「買えない」（二重に買わせない）。
 */
export function buyBlocker(state, part) {
  if (owns(state, part.id)) return 'owned';
  if (part.class_required > state.cls) return 'class';
  if (part.sponsor_tier > state.tier) return 'tier';
  if (part.price > state.money) return 'money';
  return null;
}

/** 購入。買えなければ例外（UI は先に buyBlocker で止める）。 */
export function buy(state, part) {
  const why = buyBlocker(state, part);
  if (why) throw new Error(`買えない: ${part.id} (${why})`);
  return {
    ...state,
    money: state.money - part.price,
    owned: [...state.owned, part.id],
    cond: { ...state.cond, [part.id]: part.durability },
  };
}

/** 売値。買値の sell_ratio。耐久は見ない（中古市場は細かく見ない） */
export const sellPrice = (economy, part) => Math.round(part.price * economy.sell_ratio);

/** 売却。装着中なら外れる（setup から消す）。 */
export function sell(state, part, economy) {
  if (!owns(state, part.id)) throw new Error(`持っていない: ${part.id}`);
  const cond = { ...state.cond };
  delete cond[part.id];
  return {
    ...state,
    money: state.money + sellPrice(economy, part),
    owned: state.owned.filter((id) => id !== part.id),
    cond,
    setup: stripPart(state.setup, part.id),
  };
}

/** setup（race / quali）から特定のパーツを外した写し。 */
export function stripPart(setup, partId) {
  const strip = (s) => (s ? { ...s, parts: s.parts.filter((id) => id !== partId) } : s);
  return { race: strip(setup?.race ?? { parts: [], settings: {} }), quali: strip(setup?.quali ?? null) };
}

// ---------------------------------------------------------------------------
// 収支
// ---------------------------------------------------------------------------

/** 賞金。順位は1始まり。リタイアは 0。 */
export function prizeFor(economy, cls, pos, retired = false) {
  if (retired || !pos) return 0;
  const table = economy.prize[cls] ?? [];
  return table[pos - 1] ?? 0;
}

export const entryFee = (economy, cls) => economy.entry_fee[cls] ?? 0;
export const sponsorFee = (economy, tier) => economy.sponsor_fee[tier] ?? 0;

// ---------------------------------------------------------------------------
// 消耗と修理
// ---------------------------------------------------------------------------

/** 現在の耐久。記録が無ければ満タン（買った直後）。 */
export const condition = (state, part) => state.cond?.[part.id] ?? part.durability;

/**
 * 1レースで減る耐久。車全体の reliability が低いほど速く減り、リタイアで跳ねる。
 * @param {number} reliability buildPerformance の stats.reliability
 */
export function wearPerRace(economy, reliability, retired = false) {
  const W = economy.wear;
  const base = W.per_race * (1 + W.per_reliability * Math.max(0, -reliability));
  return base * (retired ? W.retire_multiplier : 1);
}

/**
 * 耐久 → 効果の倍率。閾値以上で 1、閾値から 0 へ向かって 0.5 まで直線で落ち、0 で故障（0）。
 * 副作用には掛けない（摩耗したタービンも重さと熱はそのまま）。
 */
export function effectScale(economy, durability) {
  const th = economy.wear.threshold;
  if (durability <= 0) return 0;
  if (durability >= th) return 1;
  return 0.5 + 0.5 * (durability / th);
}

/**
 * 耐久に応じて効果を縮めたパーツの写し。buildPerformance にはこれを渡す。
 * 満タンならそのまま返す（同一性を保つ）。
 */
export function applyWear(economy, part, durability) {
  const k = effectScale(economy, durability);
  if (k >= 1) return part;
  const effects = Object.fromEntries(Object.entries(part.effects ?? {}).map(([key, v]) => [key, v * k]));
  return { ...part, effects, worn: k };
}

/** 修理費。減った割合に比例。満タンなら 0。 */
export function repairCost(economy, part, durability) {
  const missing = Math.max(0, part.durability - durability) / part.durability;
  return Math.round(part.price * economy.wear.repair_rate * missing);
}

/** 修理。耐久を上限に戻し、費用を引く。払えなければ例外。 */
export function repair(state, part, economy) {
  const cost = repairCost(economy, part, condition(state, part));
  if (cost > state.money) throw new Error(`修理費が払えない: ${part.id}`);
  return { ...state, money: state.money - cost, cond: { ...state.cond, [part.id]: part.durability } };
}

/**
 * レース後の消耗を state に反映する。装着していたパーツだけ減る。
 * @param {object[]} equippedParts  装着していたパーツ（parts.json の要素）
 * @param {number}   reliability    その車の stats.reliability
 * @returns {{ state, worn: Array<{ id, before, after }> }}
 */
export function applyRaceWear(state, equippedParts, reliability, retired, economy) {
  const loss = wearPerRace(economy, reliability, retired);
  const cond = { ...state.cond };
  const worn = [];
  for (const p of equippedParts) {
    if (!owns(state, p.id)) continue;
    const before = cond[p.id] ?? p.durability;
    const after = Math.max(0, Math.round((before - loss) * 10) / 10);
    cond[p.id] = after;
    worn.push({ id: p.id, before, after });
  }
  return { state: { ...state, cond }, worn };
}

/** 装着中のパーツの修理費の合計（収支の見積もりに使う）。 */
export function repairEstimate(state, parts, economy) {
  return parts.reduce((sum, p) => sum + repairCost(economy, p, condition(state, p)), 0);
}
