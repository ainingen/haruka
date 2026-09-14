/**
 * 1シーズンを通しで走らせて、資金の流れを見る（開発用。配布物に含めない）。
 *
 *   node tools/simulate-season.mjs [--cls 1] [--seed 1] [--strategy notes|none] [--repair always|never]
 *
 * docs/設計/経済とシーズン.md「数値の確かめ方」。
 * 「クラス1で6戦走って、中位なら2〜3点買い足せる。上位なら5点」を目安に economy.json を直す。
 * 画面のレース（スタートの混雑・交通）は入らない。simulateField の近似。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPerformance, createRng, formatTime } from '../src/engine/race.js';
import { newGame } from '../src/engine/save.js';
import { newSeason, currentRound, recordResult, simulateField, seasonOver, verdictFor, coursesFor } from '../src/engine/season.js';
import { prizeFor, entryFee, sponsorFee, applyWear, condition, applyRaceWear, repairCost, repair, buy, buyBlocker } from '../src/engine/economy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? true] : [])).filter((x) => x.length));
const CLS = Number(args.cls ?? 1);
const SEED = Number(args.seed ?? 1);
const STRATEGY = args.strategy ?? 'notes';   // notes: 親父のノート通りに買える範囲で買う / none: 何も買わない
const REPAIR = args.repair ?? 'always';

const E = load('economy.json');
const PARTS = load('parts.json');
const CHASSIS = load('chassis.json');
const COURSES = load('courses.json');
const RIVALS = load('rivals.json');
const NOTES = load('notes.json');
const driver = load('drivers.json')[0];
const CLASS_CHASSIS = { 1: 'hatchback', 2: 'sedan', 3: 'sedan', 4: 'gt', 5: 'formula' };
const part = (id) => PARTS.find((p) => p.id === id);
const yen = (n) => `${n < 0 ? '−' : ''}¥${Math.abs(Math.round(n)).toLocaleString('ja-JP')}`;

const rng = createRng(SEED);
let G = { ...newGame(E), cls: CLS, tier: Math.max(0, CLS - 1) };
G.season = newSeason(CLS, COURSES, E, rng);
const chassis = CHASSIS[CLASS_CHASSIS[CLS]];

console.log(`クラス${CLS}、seed ${SEED}、方針: ${STRATEGY}、修理: ${REPAIR}。初期資金 ${yen(G.money)}`);
console.log(`6戦: ${G.season.rounds.map((r) => r.course).join(' → ')}\n`);

let ids = ['me'];
let spent = 0;
let bought = 0;
while (!seasonOver(G.season)) {
  const round = currentRound(G.season);
  const course = COURSES.find((c) => c.id === round.course);

  // --- レース前：ノートの基準から買える順に買う（安いものから） -------------------
  if (STRATEGY === 'notes') {
    const note = NOTES.find((n) => n.course === course.id && n.class === CLS);
    const want = (note?.parts ?? []).map(part).filter(Boolean).sort((a, b) => a.price - b.price);
    for (const p of want) {
      if (!buyBlocker(G, p)) { G = buy(G, p); spent += p.price; bought += 1; }
    }
    // 買ったものは全部付ける（スロットが重なれば後勝ち）
    const parts = [];
    for (const id of G.owned) {
      const p = part(id);
      if (parts.some((q) => [q.slot, ...(q.replaces ?? [])].some((s) => [p.slot, ...(p.replaces ?? [])].includes(s)))) continue;
      parts.push(p);
    }
    G = { ...G, setup: { race: { parts: parts.map((p) => p.id), settings: note?.settings ?? {} }, quali: null } };
  }
  // --- 修理 -------------------------------------------------------------------
  let repaired = 0;
  if (REPAIR === 'always') {
    for (const id of G.setup.race.parts) {
      const p = part(id);
      const cost = repairCost(E, p, condition(G, p));
      if (cost > 0 && cost <= G.money) { G = repair(G, p, E); repaired += cost; }
    }
  }

  // --- レース ------------------------------------------------------------------
  const mine = G.setup.race.parts.map(part).filter((p) => p.class_required <= G.cls && p.sponsor_tier <= G.tier);
  const settings = G.setup.race.settings;
  const myPerf = buildPerformance(mine.map((p) => applyWear(E, p, condition(G, p))), driver, chassis, settings);
  const runs = simulateField({ myPerf, driver, mine, chassis, settings, course, laps: round.laps, rivals: RIVALS, cls: G.cls, seed: SEED * 100 + G.season.next });
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
  const repairNext = mine.reduce((sum, p) => sum + repairCost(E, p, condition(G, p)), 0);
  console.log(`第${G.season.next}戦 ${course.name.padEnd(12, '　')} ${me.retired ? 'DNF ' : `${String(me.pos).padStart(2)}位`}  賞金 ${yen(prize).padStart(10)}  参加費 ${yen(-fee).padStart(9)}  修理 ${yen(-repaired).padStart(9)}  → 所持金 ${yen(G.money).padStart(11)}  次の修理見積 ${yen(repairNext)}  装着 ${mine.length} 点`);
}

const v = verdictFor(G, ids, E);
const cheap = PARTS.filter((p) => p.class_required <= CLS && p.sponsor_tier <= G.tier && !G.owned.includes(p.id)).map((p) => p.price).sort((a, b) => a - b);
let n = 0, acc = 0;
for (const price of cheap) { if (acc + price > G.money) break; acc += price; n += 1; }
console.log(`\nシーズン結果: ${v.rank} / ${v.total} 位 → ${{ promote: '昇格', relegate: '降格', stay: '残留' }[v.verdict]}`);
console.log(`購入 ${bought} 点（${yen(spent)}）。所持金 ${yen(G.money)}。このクラスの未所有パーツを安い順にあと ${n} 点買える`);
