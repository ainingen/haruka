/**
 * data/economy.json を書き出す（開発用。配布物に含めない）。
 *
 * 賞金の表は「1位の額 × 減衰^順位」で作る。手で20行ずつ書くと直しにくいので、
 * ここに式を置いて結果だけを JSON にする。通しで走らせて外れていたら、この表を直して
 *
 *   node tools/generate-economy.mjs --write
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** クラスごとの出走台数（courses.json の grid と同じ） */
const GRID = { 1: 8, 2: 12, 3: 16, 4: 20, 5: 20 };

/**
 * 1位の賞金と減衰。パーツ価格の中央値（クラス1 32,000 / 2 90,000 / 3 160,000 / 4 850,000 / 5 4,500,000）に
 * 追随させる。「6戦で中位なら2〜3点、上位なら5点」を狙う。
 */
const PRIZE = {
  1: { first: 24000, decay: 0.80, floor: 4000 },
  2: { first: 70000, decay: 0.85, floor: 8000 },
  3: { first: 130000, decay: 0.87, floor: 12000 },
  4: { first: 700000, decay: 0.88, floor: 50000 },
  5: { first: 3500000, decay: 0.88, floor: 250000 },
};

const round = (v, unit) => Math.round(v / unit) * unit;

const prize = {};
for (const [cls, { first, decay, floor }] of Object.entries(PRIZE)) {
  const unit = first >= 1000000 ? 50000 : first >= 100000 ? 5000 : 1000;
  prize[cls] = Array.from({ length: GRID[cls] }, (_, i) => Math.max(floor, round(first * decay ** i, unit)));
}

const economy = {
  _comment: 'tools/generate-economy.mjs が書き出す。賞金の表は手で直さず、スクリプトの PRIZE を直す。',
  initial_money: 60000,
  sell_ratio: 0.4,
  rounds_per_season: 6,
  laps: { 1: 8, 2: 10, 3: 12, 4: 14, 5: 16 },
  entry_fee: { 1: 4000, 2: 15000, 3: 40000, 4: 120000, 5: 300000 },
  prize,
  sponsor_fee: [0, 6000, 30000, 100000, 300000],
  points: [10, 8, 6, 5, 4, 3, 2, 1],
  promote: { 1: 3, 2: 4, 3: 4, 4: 5 },
  relegate: { 2: 2, 3: 3, 4: 3, 5: 4 },
  wear: {
    per_race: 6,
    per_reliability: 0.06,
    retire_multiplier: 3,
    threshold: 30,
    repair_rate: 0.3,
  },
};

const out = `${JSON.stringify(economy, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(join(ROOT, 'data', 'economy.json'), out);
  console.log('data/economy.json を書き出した');
} else {
  process.stdout.write(out);
}
