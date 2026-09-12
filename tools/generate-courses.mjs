/**
 * コース形状の生成（開発用スクリプト。配布物には含めない）
 *
 *   node tools/generate-courses.mjs           生成して data/courses.json と突き合わせる
 *   node tools/generate-courses.mjs --write   data/courses.json を書き出す
 *
 * data/README.md「形の設計方針」の手順をそのまま実装したもの。
 * 手で置いた折れ線の頂点（COURSES の corners）を、頂点ごとの半径で丸めて
 * SVG の path と sectors を作る。セクター種別は丸めた円弧の半径から決まるので、
 * 曲率と種別が食い違うことがない。
 *
 * ここが形の唯一の出所。コースを直すときは data/courses.json を手で編集せず、
 * この表を直して --write で書き出す。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'courses.json');

/** クラス別の出走台数。コースの grid は、そのコースを使えるクラスぶんだけこの表から引く。 */
const GRID_SIZE = { 1: 8, 2: 12, 3: 16, 4: 20, 5: 20 };

/** 半径からセクター種別を決める境界（m）。data/README.md の表と同じ。 */
const RADIUS_BOUNDS = { slow: 120, fast: 320 };

/**
 * コースの設計データ。
 *
 * corners は閉じた折れ線の頂点を走行順に並べたもの。[x, y, 半径]、単位はメートル。
 * 座標は 5m 刻みのグリッドに置いてある（手で形を描くときに扱いやすいため）。
 * 半径は原則きりのいい値で、前後のコーナーと接線が詰まる箇所と、
 * 曲率を種別の境界から離したい箇所だけ端数にしてある。
 *
 * スタート／フィニッシュ線（走行距離 0）は最後のコーナーの立ち上がりに置く。
 * 閉じたループは総旋回角が 360° に固定されるので、左右に切り返す形にすること。
 */
const COURSES = [
  {
    id: 'nagasawa',
    name: 'ながさわ高速周回路',
    profile: 'straight',
    description: '長い直線が一本。最高速と空気抵抗で決まり、ブレーキは休ませられる。',
    classes: [2, 3, 4, 5],
    corners: [
      [1500, 0, 64], [1800, 300, 150], [1765, 750, 71], [1425, 975, 68],
      [865, 940, 75], [975, 640, 83], [450, 565, 71], [115, 715, 75],
      [-75, 375, 225], [0, 0, 233.2],
    ],
  },
  {
    id: 'misaki',
    name: 'みさき山道コース',
    profile: 'corner',
    description: '切り返しの連続。立ち上がりと回頭性で決まる。休める直線はない。',
    classes: [1, 2, 3],
    corners: [
      [0, 0, 100], [230, -120, 165], [470, 40, 105], [700, -90, 95],
      [930, 70, 180], [1120, -20, 90], [1280, 150, 110], [1180, 340, 148.6],
      [940, 300, 95], [760, 420, 105], [520, 330, 95], [330, 450, 170],
      [110, 380, 95], [-90, 470, 105], [-230, 300, 100], [-160, 110, 95],
    ],
  },
  {
    id: 'hibaridaira',
    name: 'ひばり平サーキット',
    profile: 'balanced',
    description: '直線もコーナーも平均的。セッティングの基準にするコース。',
    classes: [1, 2, 3, 4, 5],
    corners: [
      [820, 0, 190], [1120, 210, 250], [1140, 560, 260], [880, 760, 170],
      [560, 720, 105], [420, 520, 112.4], [660, 380, 100], [480, 180, 140],
      [180, 280, 115], [-40, 140, 97.5], [0, 0, 96.5],
    ],
  },
  {
    id: 'kazahaya',
    name: 'かざはや高原サーキット',
    profile: 'fast',
    description: '高低差の大きい高速コーナーが続く。ダウンフォースと剛性で曲げる。',
    classes: [3, 4, 5],
    corners: [
      [700, -80, 260], [1120, 120, 300], [1320, 460, 280], [1140, 800, 290],
      [760, 900, 240], [500, 760, 127.1], [680, 520, 127.1], [420, 380, 230],
      [60, 460, 250], [-160, 260, 110], [0, 0, 300],
    ],
  },
  {
    id: 'asahina',
    name: 'あさひなミニサーキット',
    profile: 'stopgo',
    description: '短い直線と低速コーナーの繰り返し。ブレーキが最後まで保つかで決まる。',
    classes: [1, 2, 3],
    corners: [
      [340, 0, 68], [470, 130, 62], [330, 270, 68], [470, 400, 62],
      [330, 540, 72], [140, 550, 68], [20, 410, 62], [140, 280, 68],
      [0, 170, 62], [-110, 40, 40.8], [0, 0, 130],
    ],
  },
];

// ---------------------------------------------------------------------------
// 幾何
// ---------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const norm = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => mul(a, 1 / norm(a));
/** 外積の符号。SVG は y が下向きなので、正なら画面上で右回り（sweep = 1）。 */
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];

/**
 * 1コーナーぶんの円弧。頂点 v を、入ってくる向きから出ていく向きへ半径 r で丸める。
 * 接線長 t ＝ r·tan(θ/2) だけ、頂点の手前と先が円弧に食われる。
 */
function fillet(prev, v, next, r) {
  const dirIn = unit(sub(v, prev));
  const dirOut = unit(sub(next, v));
  const turn = Math.acos(Math.max(-1, Math.min(1, dirIn[0] * dirOut[0] + dirIn[1] * dirOut[1])));
  const tangent = r * Math.tan(turn / 2);
  return {
    r,
    tangent,
    sweep: cross(dirIn, dirOut) > 0 ? 1 : 0,
    enter: add(v, mul(dirIn, -tangent)),
    exit: add(v, mul(dirOut, tangent)),
    length: r * turn,
  };
}

/** 半径 → セクター種別。全開で通過できる緩い曲がりは直線として扱う。 */
function typeOf(radius) {
  if (radius < RADIUS_BOUNDS.slow) return 'slow_corner';
  if (radius < RADIUS_BOUNDS.fast) return 'fast_corner';
  return 'straight';
}

const round1 = (n) => n.toFixed(1);
const fmt = (p) => `${round1(p[0])} ${round1(p[1])}`;

/**
 * 折れ線から、走行順の区間列（種別と正確な長さ）と path を作る。
 * 距離 0 は最後のコーナーの立ち上がり（＝ path の始点）。
 */
function buildShape(id, corners) {
  const points = corners.map(([x, y]) => [x, y]);
  const arcs = corners.map(([, , r], i) => {
    const prev = points[(i - 1 + points.length) % points.length];
    const next = points[(i + 1) % points.length];
    return fillet(prev, points[i], next, r);
  });

  // 接線長が辺を食い切っていないか。食い切ると形が破綻するので、半径を下げる合図。
  arcs.forEach((arc, i) => {
    const j = (i + 1) % arcs.length;
    const slack = norm(sub(points[j], points[i])) - arc.tangent - arcs[j].tangent;
    if (slack < -1e-6) {
      throw new Error(`${id}: 頂点 ${i} → ${j} の辺で半径が大きすぎる（${(-slack).toFixed(1)}m 足りない）`);
    }
  });

  const segments = [];
  const d = [`M${fmt(arcs.at(-1).exit)}`];
  arcs.forEach((arc, i) => {
    const from = arcs[(i - 1 + arcs.length) % arcs.length].exit;
    const straight = norm(sub(arc.enter, from));
    // 接線長がちょうど辺を使い切ると、コーナーとコーナーが直接つながる（長さ0の直線は書かない）
    if (straight > 0.05) {
      segments.push({ type: 'straight', length: straight });
      d.push(`L${fmt(arc.enter)}`);
    }
    segments.push({ type: typeOf(arc.r), length: arc.length });
    d.push(`A${round1(arc.r)} ${round1(arc.r)} 0 0 ${arc.sweep} ${fmt(arc.exit)}`);
  });
  d.push('Z');

  return { segments, path: d.join(' ') };
}

/**
 * 区間列 → sectors。
 *
 * 隣り合う同種別の区間はひとつにまとめる（緩い曲がりは前後の直線と地続きになり、
 * 連続する同種別のコーナーは1つのセクターになる）。
 * 距離は累計をメートルに丸めてから差分を取る。こうすれば
 * start + length === 次の start と「合計＝周長」が同時に満たせる。
 */
function toSectors(segments) {
  const merged = [];
  for (const seg of segments) {
    const last = merged.at(-1);
    if (last && last.type === seg.type) last.length += seg.length;
    else merged.push({ ...seg });
  }

  const bounds = [];
  let cum = 0;
  for (const seg of merged) {
    bounds.push(Math.round(cum));
    cum += seg.length;
  }
  bounds.push(Math.round(cum));

  const sectors = merged.map((seg, i) => ({
    type: seg.type,
    start: bounds[i],
    length: bounds[i + 1] - bounds[i],
  }));
  return { sectors, length: bounds.at(-1) };
}

function buildCourse(design) {
  const { segments, path } = buildShape(design.id, design.corners);
  const { sectors, length } = toSectors(segments);
  return {
    id: design.id,
    name: design.name,
    profile: design.profile,
    description: design.description,
    classes: design.classes,
    grid: Object.fromEntries(design.classes.map((c) => [c, GRID_SIZE[c]])),
    length,
    path,
    sectors,
  };
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

const generated = COURSES.map(buildCourse);
const json = `${JSON.stringify(generated, null, 2)}\n`;
const before = (() => {
  try {
    return readFileSync(OUT, 'utf8');
  } catch {
    return null;
  }
})();

for (const course of generated) {
  const ratio = (type) => Math.round(
    course.sectors.filter((s) => s.type === type).reduce((a, s) => a + s.length, 0) / course.length * 100,
  );
  console.log(
    `${course.id.padEnd(12)} ${String(course.length).padStart(5)}m  `
    + `直 ${ratio('straight')}% / 高速 ${ratio('fast_corner')}% / 低速 ${ratio('slow_corner')}%  `
    + `${course.sectors.length} セクター`,
  );
}

if (process.argv.includes('--write')) {
  writeFileSync(OUT, json);
  console.log(before === json ? '\ndata/courses.json に変化なし' : '\ndata/courses.json を書き出した');
} else if (before === json) {
  console.log('\ndata/courses.json と一致している');
} else {
  console.log('\ndata/courses.json と差がある。--write で書き出すこと');
  process.exitCode = 1;
}
