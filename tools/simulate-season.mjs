/**
 * 1シーズンを通しで走らせて、資金の流れを見る（開発用。配布物に含めない）。
 *
 *   node tools/simulate-season.mjs [--cls 1] [--seed 1] [--strategy none|notes|smart]
 *                                  [--parts N] [--money N] [--repair always|never] [--quiet]
 *
 *   none  ：何も買わない（純正）
 *   notes ：親父のノート通りに、毎戦買える範囲で買う（コースごとに引き直す）
 *   smart ：6戦のコースを「時間」で見て効く効果を採点し、毎戦買える範囲で上から 5 点まで買う
 *
 *   --parts N ：買う点数の上限（notes / smart）。ノートの安い順に N 点でやめる。既定は上限なし
 *   --frac F  ：上限をノートの割合で（--frac 0.6 ＝ そのコースのノートの6割まで）。--parts より優先。
 *               **目安はこちらで見る。** クラスによってノートの長さが違うので、
 *               同じ「3点」がクラス1では8割、クラス4では2割になってしまう
 *   --money N ：初期資金の上書き。上のクラスは newGame の資金では1点も買えないので、
 *               そのクラスに上がってきたときの手持ちを外から与える（既定は CLASS_MONEY）。
 *   --quiet   ：戦ごとの行を出さず、最後に1行の要約（TSV）だけを出す。掃き出し用。
 *
 * docs/設計/経済とシーズン.md「数値の確かめ方」。目安（台数に按分）：
 *   買わない → 下位1/4、ノートの6割 → 台数×(5〜6)/8、ノート全点 → 並より上。
 *   クラス1だけは例外（ノートが4〜5点しかないので、6割でもう並と同じ位置になる）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPerformance, createRng, WEIGHTS } from '../src/engine/race.js';
import { newGame } from '../src/engine/save.js';
import { newSeason, currentRound, recordResult, simulateField, seasonOver, verdictFor } from '../src/engine/season.js';
import { baselineFor } from '../src/engine/rivals.js';
import { prizeFor, entryFee, sponsorFee, applyWear, condition, applyRaceWear, repairCost, repair, buy, buyBlocker } from '../src/engine/economy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? true] : [])).filter((x) => x.length));
const CLS = Number(args.cls ?? 1);
const SEED = Number(args.seed ?? 1);
const STRATEGY = args.strategy ?? 'notes';
const REPAIR = args.repair ?? 'always';
const PARTS_CAP = args.parts === undefined ? Infinity : Number(args.parts);
// 点数をノートの割合で止める（--frac 0.6 ＝ そのコースのノートの6割まで）。
// クラスによってノートの長さが違うので、目安はこちらで見る
const PARTS_FRAC = args.frac === undefined ? null : Number(args.frac);
const capFor = (note) => (PARTS_FRAC === null ? PARTS_CAP : Math.round(note.length * PARTS_FRAC));
const QUIET = !!args.quiet;
const say = (...a) => { if (!QUIET) console.log(...a); };

const E = load('economy.json');
const PARTS = load('parts.json');
const CHASSIS = load('chassis.json');
const COURSES = load('courses.json');
// --rivals で名簿を差し替えられる（比率を試すとき。既定は data/rivals.json）
const RIVALS = args.rivals ? JSON.parse(readFileSync(String(args.rivals), 'utf8')) : load('rivals.json');
const NOTES = load('notes.json');
const driver = load('drivers.json')[0];
const CLASS_CHASSIS = { 1: 'hatchback', 2: 'sedan', 3: 'sedan', 4: 'gt', 5: 'formula' };
const part = (id) => PARTS.find((p) => p.id === id);
const yen = (n) => `${n < 0 ? '−' : ''}¥${Math.abs(Math.round(n)).toLocaleString('ja-JP')}`;
const conflicts = (a, b) => [a.slot, ...(a.replaces ?? [])].some((s) => [b.slot, ...(b.replaces ?? [])].includes(s));

/**
 * そのクラスに上がってきたときの手持ち。クラス1は新規開始の資金。
 * 2以上は「そのクラスの1位賞金 × 2」— 下のクラスを勝ち上がってきた人が、
 * 最初の買い物で2〜3点は選べる額。上のクラスを newGame の資金で測ると1点も買えない。
 */
const CLASS_MONEY = (cls) => (cls <= 1 ? E.initial_money : E.prize[cls][0] * 2);

const rng = createRng(SEED);
let G = { ...newGame(E), cls: CLS, tier: Math.max(0, CLS - 1) };
G.money = args.money === undefined ? CLASS_MONEY(CLS) : Number(args.money);
G.season = newSeason(CLS, COURSES, E, rng);
const chassis = CHASSIS[CLASS_CHASSIS[CLS]];

const capLabel = PARTS_FRAC !== null ? `（ノートの${PARTS_FRAC * 10}割まで）` : Number.isFinite(PARTS_CAP) ? `（${PARTS_CAP}点まで）` : '';
say(`クラス${CLS}、seed ${SEED}、方針: ${STRATEGY}${capLabel}、修理: ${REPAIR}。初期資金 ${yen(G.money)}`);
say(`6戦: ${G.season.rounds.map((r) => r.course).join(' → ')}\n`);

/**
 * 「賢く選ぶ」：6戦のコースを、セクター種別ごとの**所要時間**の比で見る（距離ではなく時間で効く）。
 * race.js の WEIGHTS.sector と同じ向きでパーツの効果＋副作用を採点し、上位 5 点を買い物リストにする。
 */
function seasonTimeMix() {
  const mix = { straight: 0, fast_corner: 0, slow_corner: 0 };
  for (const r of G.season.rounds) {
    const c = COURSES.find((x) => x.id === r.course);
    for (const sec of c.sectors) mix[sec.type] += sec.length / chassis.base_speed[sec.type];
  }
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(mix)) mix[k] /= total;
  return mix;
}
function smartScore(p, mix) {
  let score = 0;
  for (const [type, w] of Object.entries(mix)) {
    for (const [key, coef] of Object.entries(WEIGHTS.sector[type])) {
      const k = key === 'weight_eff' ? 'weight' : key === 'balance_dev' ? null : key;
      if (!k) continue;
      score += w * coef * ((p.effects?.[k] ?? 0) + (p.side_effects?.[k] ?? 0));
    }
  }
  return score;
}
const SMART_LIST = STRATEGY === 'smart'
  ? (() => {
    const mix = seasonTimeMix();
    const ranked = PARTS.filter((p) => p.class_required <= G.cls && p.sponsor_tier <= G.tier)
      .map((p) => ({ p, s: smartScore(p, mix) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.p);
    const list = [];
    const cap = Math.min(5, PARTS_CAP);
    for (const p of ranked) { if (list.length >= cap) break; if (!list.some((c) => conflicts(c, p))) list.push(p); }
    say(`時間比 直線 ${(mix.straight * 100).toFixed(0)}% / 高速 ${(mix.fast_corner * 100).toFixed(0)}% / 低速 ${(mix.slow_corner * 100).toFixed(0)}%`);
    say(`賢く選ぶ候補 ${list.length} 点: ${list.map((p) => `${p.name}(${yen(p.price)})`).join('、')}\n`);
    return list;
  })()
  : [];

let ids = ['me'];
let spent = 0;
let bought = 0;
const finishes = [];   // 戦ごとの着順（リタイアは null）
while (!seasonOver(G.season)) {
  const round = currentRound(G.season);
  const course = COURSES.find((c) => c.id === round.course);

  // --- レース前：買い物（毎戦、買える範囲で） ------------------------------------
  if (STRATEGY === 'notes') {
    // ノートは AI の「並」と同じ引き方（rivals.js baselineFor）。そのコース・クラスに無ければ
    // 下のクラス、それも無ければ同じクラスの別コース。クラス5には自前のノートがまだ無い
    const base = baselineFor(NOTES, PARTS, course, G.cls);
    const note = base.note;
    const want = [...base.parts].sort((a, b) => a.price - b.price);
    // 安い順に買う。--parts があればその点数でやめる（「ノート通り3点」はこれ）
    for (const p of want) {
      if (G.owned.length >= capFor(base.parts)) break;
      if (!buyBlocker(G, p)) { G = buy(G, p); spent += p.price; bought += 1; }
    }
    // 装着は**そのコースのノートを先に**。残りのスロットを他の所持パーツで埋める。
    // 所持順（＝安い順）に付けると、前の戦で買った安いタイヤが良いタイヤを塞ぐ
    const parts = [];
    const add = (p) => { if (p && G.owned.includes(p.id) && !parts.some((q) => conflicts(q, p))) parts.push(p); };
    for (const p of base.parts) add(p);
    for (const id of G.owned) add(part(id));
    G = { ...G, setup: { race: { parts: parts.map((p) => p.id), settings: note?.settings ?? {} }, quali: null } };
  } else if (STRATEGY === 'smart') {
    for (const p of SMART_LIST) if (!buyBlocker(G, p)) { G = buy(G, p); spent += p.price; bought += 1; }
    const parts = SMART_LIST.filter((p) => G.owned.includes(p.id));
    G = { ...G, setup: { race: { parts: parts.map((p) => p.id), settings: {} }, quali: null } };
  }
  // --- 修理 -------------------------------------------------------------------
  let repaired = 0;
  if (REPAIR === 'always') {
    for (const id of G.setup.race.parts) {
      const p = part(id);
      const cost = repairCost(E, p, condition(G, p), G.cls);
      if (cost > 0 && cost <= G.money) { G = repair(G, p, E); repaired += cost; }
    }
  }

  // --- レース ------------------------------------------------------------------
  const mine = G.setup.race.parts.map(part).filter((p) => p.class_required <= G.cls && p.sponsor_tier <= G.tier);
  const settings = G.setup.race.settings;
  const myPerf = buildPerformance(mine.map((p) => applyWear(E, p, condition(G, p))), driver, chassis, settings);
  const runs = simulateField({ myPerf, driver, chassis, course, laps: round.laps, rivals: RIVALS, parts: PARTS, notes: NOTES, cls: G.cls, seed: SEED * 100 + G.season.next, rivalSeed: G.season.rivalSeed });
  ids = runs.map((r) => r.id);
  const me = runs.find((r) => r.id === 'me');
  const prize = prizeFor(E, G.cls, me.pos, me.retired);
  const fee = entryFee(E, G.cls);
  const sp = sponsorFee(E, G.tier);
  const wear = applyRaceWear(G, mine, myPerf.stats.reliability, me.retired, E);
  const net = prize + sp - fee;
  G = { ...wear.state, money: G.money + net };
  G = recordResult(G, {
    classification: runs.map((r) => ({ id: r.id, pos: r.pos, retired: r.retired })),
    mine: { pos: me.retired ? null : me.pos, retired: me.retired, prize, fee, sponsorFee: sp, repair: 0, best: me.best },
  }, E);
  finishes.push(me.retired ? null : me.pos);
  const repairNext = mine.reduce((sum, p) => sum + repairCost(E, p, condition(G, p), G.cls), 0);
  say(`第${G.season.next}戦 ${course.name.padEnd(12, '　')} ${me.retired ? 'DNF ' : `${String(me.pos).padStart(2)}位`}  賞金 ${yen(prize).padStart(10)}  参加費 ${yen(-fee).padStart(9)}  修理 ${yen(-repaired).padStart(9)}  → 所持金 ${yen(G.money).padStart(11)}  次の修理見積 ${yen(repairNext)}  装着 ${mine.length} 点`);
}

const v = verdictFor(G, ids, E);
const cheap = PARTS.filter((p) => p.class_required <= CLS && p.sponsor_tier <= G.tier && !G.owned.includes(p.id)).map((p) => p.price).sort((a, b) => a - b);
let n = 0, acc = 0;
for (const price of cheap) { if (acc + price > G.money) break; acc += price; n += 1; }
// 目安は着順で見る。シーズン順位はポイント圏外が団子になるので、平均着順を正とする
const scored = finishes.filter((p) => p !== null);
const avg = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : NaN;
say(`\nシーズン結果: ${v.rank} / ${v.total} 位 → ${{ promote: '昇格', relegate: '降格', stay: '残留' }[v.verdict]}`);
say(`着順 ${finishes.map((p) => p ?? 'DNF').join(' ')}（平均 ${avg.toFixed(1)} / ${v.total} 台）`);
say(`購入 ${bought} 点（${yen(spent)}）。所持金 ${yen(G.money)}。このクラスの未所有パーツを安い順にあと ${n} 点買える`);
// --quiet のときの1行。掃き出して表にする（cls, seed, 方針, 台数, 着順…, 平均, DNF, 購入点数, 所持金）
if (QUIET) {
  const label = STRATEGY === 'none' ? 'none'
    : PARTS_FRAC !== null ? `${STRATEGY}-${PARTS_FRAC}`
    : `${STRATEGY}${Number.isFinite(PARTS_CAP) ? PARTS_CAP : ''}`;
  console.log([CLS, SEED, label, v.total, finishes.map((p) => p ?? 'DNF').join('/'),
    avg.toFixed(2), finishes.length - scored.length, bought, Math.round(G.money)].join('\t'));
}
