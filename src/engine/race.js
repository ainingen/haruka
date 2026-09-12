/**
 * レース計算エンジン（docs/設計/レース方式.md）
 *
 * 物理演算はしない。装着パーツから車両性能を合成し、コースのセクターごとに
 * 通過時間を求めて周回を積み上げる。
 *
 * このモジュールは I/O を持たない純関数群。データ（parts / chassis / courses / drivers）は
 * 呼び出し側が読み込んで渡す。Node でもブラウザでもそのまま動く。
 *
 * 単位：長さ m、速度 m/s、時間 s。性能値は data/README.md の無次元ポイント。
 */

/** data/README.md の語彙。ここに無いキーが parts / chassis に現れたら例外にする。 */
export const KEYS = Object.freeze([
  'power', 'top_end_power', 'low_end_torque', 'throttle_response', 'acceleration', 'top_speed', 'traction',
  'cornering_grip', 'braking', 'fade_resistance', 'turn_in', 'stability', 'road_compliance', 'rigidity', 'balance',
  'downforce', 'drag', 'weight', 'unsprung_weight',
  'warmup', 'tire_wear', 'heat', 'fuel_consumption', 'reliability',
  'noise', 'driver_demand',
]);

export const SECTOR_TYPES = Object.freeze(['straight', 'fast_corner', 'slow_corner']);

/**
 * 重み付け。テスト（race.test.js）が通り、かつ差が体感できる範囲（0.3〜2秒/周）に
 * 収まるよう調整した値。ここだけを触れば挙動が変わる。
 *
 * sector.* の値は「性能1ポイントあたり、そのセクターの速度が何％変わるか」。
 */
export const WEIGHTS = {
  /** ばね下重量は weight の何倍相当か */
  unsprungFactor: 5,
  /** 速度係数の下限（副作用を積みすぎても止まらないように） */
  minSpeedFactor: 0.2,

  sector: {
    straight: {
      power: 0.30, top_speed: 0.40, top_end_power: 0.15,
      drag: -0.35, weight_eff: -0.06,
    },
    fast_corner: {
      downforce: 0.60, cornering_grip: 0.35, stability: 0.15, rigidity: 0.10, road_compliance: 0.10,
      weight_eff: -0.04, balance_dev: -0.60,
    },
    slow_corner: {
      acceleration: 0.40, traction: 0.30, braking: 0.25, turn_in: 0.25,
      low_end_torque: 0.25, throttle_response: 0.10, road_compliance: 0.15,
      weight_eff: -0.05, balance_dev: -0.25,
    },
  },

  tire: {
    /** 基準タイヤ（tire_wear = 0, heat = 0）の1周あたり摩耗量 */
    baseWearPerLap: 0.02,
    /** tire_wear 1ポイントあたりの摩耗倍率の増分 */
    wearPerPoint: 0.15,
    /** heat 1ポイントあたりの摩耗倍率の増分（負の heat は摩耗を減らさない） */
    heatPerPoint: 0.05,
    /** 摩耗 1.0 でグリップから引くポイント数 */
    gripLossAtFullWear: 24,
    /** 摩耗の効き方の指数。>1 なら序盤は緩く終盤で急に落ちる */
    wearExponent: 1.3,
    /** 摩耗の上限（これ以上は「終わったタイヤ」として一定） */
    maxWear: 1.2,
    /** traction はグリップ低下の何割を受けるか */
    tractionShare: 0.7,
    /** 冷間時に引くポイント数（1周目の走り出し） */
    coldGripLoss: 6,
    /** warmup = 0 のとき、温まりきるまでの周回数 */
    coldLapsBase: 2,
    /** warmup 1ポイントあたり短縮される周回数 */
    coldLapsPerWarmup: 0.4,
  },

  driver: {
    /** skill 0 のときのラップタイム増加率（skill 100 で 0） */
    skillTimePenalty: 0.15,
    /** driver_demand 1ポイント × (demandSkillRef − skill)/10 あたりの増加率 */
    demandPenalty: 0.0015,
    /** この skill 以上なら driver_demand の影響を受けない */
    demandSkillRef: 85,
    /** consistency 0 のときのラップごとのばらつき（標準偏差、比率） */
    noiseAtZeroConsistency: 0.01,
  },

  reliability: {
    /** reliability −1ポイントあたりの、1周ごとのリタイア確率 */
    retirePerPointPerLap: 0.0015,
  },
};

// ---------------------------------------------------------------------------
// 乱数（シード固定できるように自前で持つ）
// ---------------------------------------------------------------------------

/** mulberry32。seed が同じなら同じ列を返す。 */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// 車両性能の合成
// ---------------------------------------------------------------------------

function addStats(stats, delta, source) {
  for (const [key, value] of Object.entries(delta ?? {})) {
    if (!(key in stats)) {
      throw new Error(`未定義のキー "${key}"（${source}）。data/README.md の語彙に追加してから使うこと`);
    }
    stats[key] += value;
  }
}

/**
 * 装着パーツ一覧から performance を合成する。
 * effects と side_effects は符号付きで単純合算（data/README.md の規約）。
 *
 * @param {object[]} parts   parts.json の要素
 * @param {object}   driver  drivers.json の要素（preferred_balance を使う）
 * @param {object}   chassis chassis.json の要素（base_speed と base）
 */
export function buildPerformance(parts, driver, chassis) {
  if (!chassis?.base_speed) throw new Error('chassis に base_speed がない');
  const stats = Object.fromEntries(KEYS.map((k) => [k, 0]));
  addStats(stats, chassis.base, `chassis:${chassis.id}`);
  for (const part of parts) {
    addStats(stats, part.effects, part.id);
    addStats(stats, part.side_effects, part.id);
  }
  const weightEff = stats.weight + WEIGHTS.unsprungFactor * stats.unsprung_weight;
  const balanceDev = Math.abs(stats.balance - (driver?.preferred_balance ?? 0));
  return {
    chassisId: chassis.id,
    baseSpeed: chassis.base_speed,
    partIds: parts.map((p) => p.id),
    stats,
    weightEff,
    balanceDev,
  };
}

// ---------------------------------------------------------------------------
// タイヤ
// ---------------------------------------------------------------------------

export function createTireState() {
  return { wear: 0, lapsRun: 0 };
}

/** 1周あたりの摩耗量。tire_wear と heat で増える。 */
export function wearPerLap(stats) {
  const T = WEIGHTS.tire;
  const byCompound = Math.max(0.2, 1 + T.wearPerPoint * stats.tire_wear);
  const byHeat = 1 + T.heatPerPoint * Math.max(0, stats.heat);
  return T.baseWearPerLap * byCompound * byHeat;
}

/** 現在のタイヤ状態で、グリップから引くポイント数（冷間 + 摩耗）。 */
export function tireGripLoss(stats, tire) {
  const T = WEIGHTS.tire;
  const coldLaps = Math.max(0, T.coldLapsBase - stats.warmup * T.coldLapsPerWarmup);
  const cold = tire.lapsRun < coldLaps ? T.coldGripLoss * (1 - tire.lapsRun / coldLaps) : 0;
  const worn = T.gripLossAtFullWear * Math.pow(Math.min(tire.wear, T.maxWear), T.wearExponent);
  return { cold, worn, total: cold + worn };
}

export function advanceTire(tire, stats) {
  return { wear: tire.wear + wearPerLap(stats), lapsRun: tire.lapsRun + 1 };
}

// ---------------------------------------------------------------------------
// セクター通過時間
// ---------------------------------------------------------------------------

/** タイヤ状態を反映した実効性能。セクター計算はこれを見る。 */
export function effectiveStats(perf, tire) {
  const loss = tireGripLoss(perf.stats, tire);
  return {
    ...perf.stats,
    cornering_grip: perf.stats.cornering_grip - loss.total,
    traction: perf.stats.traction - loss.total * WEIGHTS.tire.tractionShare,
    weight_eff: perf.weightEff,
    balance_dev: perf.balanceDev,
  };
}

/** セクター種別ごとの速度 (m/s)。基準速度 × (1 + 重み付き合計％)。 */
export function sectorSpeed(type, eff, baseSpeed) {
  const weights = WEIGHTS.sector[type];
  if (!weights) throw new Error(`未知のセクター種別 "${type}"`);
  let pct = 0;
  for (const [key, coef] of Object.entries(weights)) pct += coef * eff[key];
  return baseSpeed[type] * Math.max(WEIGHTS.minSpeedFactor, 1 + pct / 100);
}

export function sectorTime(sector, eff, baseSpeed) {
  return sector.length / sectorSpeed(sector.type, eff, baseSpeed);
}

/**
 * ドライバーによる時間係数。skill が低いほど遅く、driver_demand の高い車ほど
 * その差が広がる。skill が demandSkillRef 以上なら driver_demand は効かない。
 */
export function driverTimeFactor(driver, stats) {
  const D = WEIGHTS.driver;
  const skill = driver?.skill ?? 100;
  const bySkill = D.skillTimePenalty * (100 - skill) / 100;
  const byDemand = D.demandPenalty * Math.max(0, stats.driver_demand) * Math.max(0, D.demandSkillRef - skill) / 10;
  return 1 + bySkill + byDemand;
}

/** 1周の所要時間（乱数なし）。 */
export function lapTime(perf, course, tire, driver) {
  const eff = effectiveStats(perf, tire);
  const factor = driverTimeFactor(driver, perf.stats);
  const sectors = course.sectors.map((s) => sectorTime(s, eff, perf.baseSpeed) * factor);
  return {
    time: sectors.reduce((a, b) => a + b, 0),
    sectors,
    gripLoss: tireGripLoss(perf.stats, tire),
  };
}

// ---------------------------------------------------------------------------
// レース
// ---------------------------------------------------------------------------

/**
 * 1台をレース周回させる。
 *
 * @param {object} perf    buildPerformance の戻り値
 * @param {object} course  courses.json の要素
 * @param {number} laps    周回数
 * @param {object} driver  drivers.json の要素
 * @param {object} [options]
 * @param {number}  [options.seed=1]     乱数シード
 * @param {boolean} [options.noise=true] consistency によるラップのばらつきを入れる
 * @param {boolean} [options.retire=true] reliability によるリタイア判定を入れる
 */
export function simulateRace(perf, course, laps, driver, options = {}) {
  const { seed = 1, noise = true, retire = true } = options;
  const rng = createRng(seed);
  const sigma = WEIGHTS.driver.noiseAtZeroConsistency * (100 - (driver?.consistency ?? 100)) / 100;
  const retireP = WEIGHTS.reliability.retirePerPointPerLap * Math.max(0, -perf.stats.reliability);

  const result = { courseId: course.id, laps: [], total: 0, best: Infinity, retired: false, retiredLap: null };
  let tire = createTireState();

  for (let i = 0; i < laps; i++) {
    if (retire && rng() < retireP) {
      result.retired = true;
      result.retiredLap = i + 1;
      break;
    }
    const lt = lapTime(perf, course, tire, driver);
    let time = lt.time;
    if (noise) time *= 1 + sigma * gaussian(rng);

    result.laps.push({ lap: i + 1, time, sectors: lt.sectors, wear: tire.wear, gripLoss: lt.gripLoss.total });
    result.total += time;
    if (time < result.best) result.best = time;
    tire = advanceTire(tire, perf.stats);
  }
  result.average = result.laps.length ? result.total / result.laps.length : NaN;
  return result;
}

/** 秒 → "m:ss.mmm" */
export function formatTime(sec) {
  if (!Number.isFinite(sec)) return '--:--.---';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
