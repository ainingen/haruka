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
 * 装着スロット。装着の排他はカテゴリではなくスロット単位で決まる。
 * 配列の順序が正で、パーツの「ホームスロット」は占有スロットのうち最も前のもの。
 */
export const SLOTS = Object.freeze({
  engine:      ['intake', 'exhaust', 'ecu', 'cam', 'forced_induction'],
  drivetrain:  ['final', 'clutch', 'lsd', 'gearbox'],
  suspension:  ['damper', 'camber', 'toe', 'stabi_front', 'stabi_rear'],
  tire:        ['compound'],
  brake:       ['pad', 'rotor', 'caliper', 'bias'],
  aero_weight: ['interior', 'body', 'wheel', 'aero'],
});

/** そのパーツが占有するスロット。ユニット部品は replaces で複数を埋める。 */
export function occupiedSlots(part) {
  return [part.slot, ...(part.replaces ?? [])].filter(Boolean);
}

/**
 * 装着リストを正規化する。配列でも、スロット → パーツ の対応表でも受け取れる。
 * 同じスロットを2つのパーツが取り合っていたら例外にする（UI のバグを早く見つけるため）。
 * slot を持たないパーツ（テスト用の合成パーツなど）は排他の対象外。
 */
export function resolveLoadout(loadout) {
  const parts = Array.isArray(loadout)
    ? loadout.filter(Boolean)
    : [...new Set(Object.values(loadout ?? {}).filter(Boolean))];
  const taken = new Map();
  for (const part of parts) {
    for (const slot of occupiedSlots(part)) {
      if (taken.has(slot)) {
        throw new Error(`スロット "${slot}" が重複している（${taken.get(slot)} と ${part.id}）`);
      }
      taken.set(slot, part.id);
    }
  }
  return parts;
}

/**
 * 重み付け。テスト（race.test.js）が通り、かつ差が体感できる範囲（0.3〜2秒/周）に
 * 収まるよう調整した値。ここだけを触れば挙動が変わる。
 *
 * sector.* の値は「性能1ポイントあたり、そのセクターの速度が何％変わるか」。
 */
export const WEIGHTS = {
  /** ばね下重量は weight の何倍相当か（セクター別）。直線では単なる質量、コーナーでは路面追従に効く */
  unsprungFactor: { straight: 1, fast_corner: 5, slow_corner: 5 },
  /** 速度係数の下限（副作用を積みすぎても止まらないように） */
  minSpeedFactor: 0.2,

  sector: {
    straight: {
      power: 0.30, top_speed: 0.40, top_end_power: 0.15, stability: 0.10,
      drag: -0.35, weight_eff: -0.06,
    },
    fast_corner: {
      downforce: 0.47, cornering_grip: 0.35, stability: 0.15, rigidity: 0.10, road_compliance: 0.10,
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

  brake: {
    /** 1周あたりの温度上昇 = loadGain × (低速コーナー距離 / 周長) × (1 + heatPerPoint × heat) */
    loadGain: 150,
    /** 1周あたりの放熱率（温度に比例）。直線比率が高いほど冷える */
    coolBase: 0.15,
    coolPerStraightRatio: 0.30,
    /** heat 1ポイントあたりの温度上昇の増分（負なら放熱が良い） */
    heatPerPoint: 0.05,
    /** フェードが始まる温度。fade_resistance で上がる */
    thresholdBase: 100,
    thresholdPerFadeResistance: 12,
    /** 閾値を超えた1度あたり、braking から引くポイント数 */
    lossPerDegree: 0.15,
  },

  reliability: {
    /** reliability −1ポイントあたりの、1周ごとのリタイア確率 */
    retirePerPointPerLap: 0.0015,
  },
};

/**
 * 連続値セッティング。パーツとは別に、走行前に決める数値。
 *
 * `unlockedBy` が null なら常に触れる。配列なら、そのいずれかのパーツを装着したときだけ解禁される。
 * `toStats(value, chassis)` が返す差分は、パーツの effects / side_effects と同じ語彙・同じ向きで合算される。
 */
export const SETTINGS = {
  tire_pressure: {
    key: 'tire_pressure',
    label: '空気圧',
    unit: 'bar',
    step: 0.05,
    unlockedBy: null,
    rangeFor: () => ({ min: 1.6, max: 2.6 }),
    defaultValue: () => 2.1,
    /** 高いほど早く温まるが早くタレる。基準から離れるほど接地形状が崩れてグリップが落ちる。 */
    toStats(value) {
      const d = (value - this.defaultValue()) / 0.1;
      return { warmup: 1.2 * d, tire_wear: 0.8 * d, cornering_grip: -0.4 * Math.abs(d) };
    },
  },

  ride_height: {
    key: 'ride_height',
    label: '車高',
    unit: 'mm',
    step: 5,
    unlockedBy: ['suspension_coilover_01', 'suspension_coilover_02', 'suspension_works_01'],
    rangeFor: (chassis) => {
      const base = chassis.display.ride_height_mm;
      return { min: base - 40, max: base + 20 };
    },
    defaultValue: (chassis) => chassis.display.ride_height_mm,
    /** 下げれば重心が下がって空力も効くが、ストロークが減って路面追従が落ちる。 */
    toStats(value, chassis) {
      const drop = (chassis.display.ride_height_mm - value) / 10;
      return { downforce: 1.5 * drop, drag: -0.3 * drop, cornering_grip: 0.5 * drop, road_compliance: -1.8 * drop };
    },
  },

  brake_bias: {
    key: 'brake_bias',
    label: 'ブレーキ前後配分',
    unit: '% 前',
    step: 1,
    unlockedBy: ['brake_bias_01', 'brake_works_01'],   // ワークス系は配分調整を内蔵する
    rangeFor: () => ({ min: 50, max: 70 }),
    defaultValue: () => 60,
    /**
     * 後ろに寄せれば頭が入り、前後バランスもオーバー寄りに動く。代わりに安定を失い、
     * どちらに振ってもロックしやすくなって制動距離は伸びる。
     * balance に効くので「アンダーな車を配分で釣り合わせる」使い方ができる
     * ＝ 基準の 60% が常に最適ではない。
     */
    toStats(value) {
      const d = this.defaultValue() - value;
      return { turn_in: 0.5 * d, stability: -0.4 * d, braking: -0.08 * d * d, balance: 0.25 * d };
    },
  },
};

/** そのパーツ構成でこのセッティングを触れるか。 */
export function isSettingUnlocked(def, parts) {
  if (!def.unlockedBy) return true;
  return parts.some((p) => def.unlockedBy.includes(p.id));
}

/** 現在のパーツ構成で触れるセッティングの一覧（UI 用）。 */
export function availableSettings(parts, chassis) {
  return Object.values(SETTINGS)
    .filter((def) => isSettingUnlocked(def, parts))
    .map((def) => ({ def, ...def.rangeFor(chassis), step: def.step, defaultValue: def.defaultValue(chassis) }));
}

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
 * 連続値セッティング（空気圧・車高・ブレーキ前後配分）を渡すと、解禁されているものだけが
 * 同じ語彙の差分として合算される。渡さなければ基準値（差分ゼロ）として扱う。
 *
 * @param {object[]|Object<string,object>} loadout
 *        parts.json の要素の配列、または スロット → パーツ の対応表（UI はこちらを渡す）
 * @param {object}   driver   drivers.json の要素（preferred_balance を使う）
 * @param {object}   chassis  chassis.json の要素（base_speed と base）
 * @param {object}   [settings] { tire_pressure, ride_height, brake_bias } の一部または全部
 */
export function buildPerformance(loadout, driver, chassis, settings = null) {
  if (!chassis?.base_speed) throw new Error('chassis に base_speed がない');
  const parts = resolveLoadout(loadout);
  const stats = Object.fromEntries(KEYS.map((k) => [k, 0]));
  addStats(stats, chassis.base, `chassis:${chassis.id}`);
  for (const part of parts) {
    addStats(stats, part.effects, part.id);
    addStats(stats, part.side_effects, part.id);
  }
  for (const [key, value] of Object.entries(settings ?? {})) {
    const def = SETTINGS[key];
    if (!def) throw new Error(`未知のセッティング "${key}"`);
    if (!isSettingUnlocked(def, parts)) continue;
    if (value === null || value === undefined) continue;
    addStats(stats, def.toStats(value, chassis), `setting:${key}`);
  }
  const weightEff = Object.fromEntries(
    SECTOR_TYPES.map((t) => [t, stats.weight + WEIGHTS.unsprungFactor[t] * stats.unsprung_weight]),
  );
  const balanceDev = Math.abs(stats.balance - (driver?.preferred_balance ?? 0));
  return {
    chassisId: chassis.id,
    baseSpeed: chassis.base_speed,
    partIds: parts.map((p) => p.id),
    settings: settings ?? {},
    stats,
    /** セクター種別ごとの有効重量 */
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
// ブレーキ温度（フェード）
// ---------------------------------------------------------------------------

export function createBrakeState() {
  return { temp: 0 };
}

/** コースの負荷プロファイル。周長に対する低速コーナー比率と直線比率。 */
export function courseLoad(course) {
  const total = course.sectors.reduce((a, s) => a + s.length, 0);
  const sum = (type) => course.sectors.filter((s) => s.type === type).reduce((a, s) => a + s.length, 0);
  return { total, slowRatio: sum('slow_corner') / total, straightRatio: sum('straight') / total };
}

/** 1周走った後のブレーキ温度。低速コーナーで溜まり、直線で冷える。 */
export function advanceBrakes(brake, stats, load) {
  const B = WEIGHTS.brake;
  const gain = B.loadGain * load.slowRatio * Math.max(0.3, 1 + B.heatPerPoint * stats.heat);
  const cool = B.coolBase + B.coolPerStraightRatio * load.straightRatio;
  return { temp: Math.max(0, brake.temp * (1 - cool) + gain) };
}

/** フェードで braking から引くポイント数。閾値以下なら 0。 */
export function brakeFadeLoss(stats, brake) {
  const B = WEIGHTS.brake;
  const threshold = B.thresholdBase + B.thresholdPerFadeResistance * stats.fade_resistance;
  return Math.max(0, brake.temp - threshold) * B.lossPerDegree;
}

// ---------------------------------------------------------------------------
// セクター通過時間
// ---------------------------------------------------------------------------

/** タイヤ・ブレーキ状態を反映した実効性能。セクター計算はこれを見る。 */
export function effectiveStats(perf, tire, brake = createBrakeState()) {
  const loss = tireGripLoss(perf.stats, tire);
  return {
    ...perf.stats,
    cornering_grip: perf.stats.cornering_grip - loss.total,
    traction: perf.stats.traction - loss.total * WEIGHTS.tire.tractionShare,
    braking: perf.stats.braking - brakeFadeLoss(perf.stats, brake),
    weight_eff: perf.weightEff,
    balance_dev: perf.balanceDev,
  };
}

/** セクター種別ごとの速度 (m/s)。基準速度 × (1 + 重み付き合計％)。 */
export function sectorSpeed(type, eff, baseSpeed) {
  const weights = WEIGHTS.sector[type];
  if (!weights) throw new Error(`未知のセクター種別 "${type}"`);
  let pct = 0;
  for (const [key, coef] of Object.entries(weights)) {
    const value = key === 'weight_eff' ? eff.weight_eff[type] : eff[key];
    pct += coef * value;
  }
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
export function lapTime(perf, course, tire, driver, brake = createBrakeState()) {
  const eff = effectiveStats(perf, tire, brake);
  const factor = driverTimeFactor(driver, perf.stats);
  const sectors = course.sectors.map((s) => sectorTime(s, eff, perf.baseSpeed) * factor);
  return {
    time: sectors.reduce((a, b) => a + b, 0),
    sectors,
    gripLoss: tireGripLoss(perf.stats, tire),
    brakeFade: brakeFadeLoss(perf.stats, brake),
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
 *
 * 周回ごとにタイヤ摩耗とブレーキ温度が進む。ブレーキは低速コーナー比率の高いコースで
 * 溜まりやすく、fade_resistance が閾値を押し上げる。
 */
export function simulateRace(perf, course, laps, driver, options = {}) {
  const { seed = 1, noise = true, retire = true } = options;
  const rng = createRng(seed);
  const sigma = WEIGHTS.driver.noiseAtZeroConsistency * (100 - (driver?.consistency ?? 100)) / 100;
  const retireP = WEIGHTS.reliability.retirePerPointPerLap * Math.max(0, -perf.stats.reliability);

  const load = courseLoad(course);
  const result = { courseId: course.id, laps: [], total: 0, best: Infinity, retired: false, retiredLap: null };
  let tire = createTireState();
  let brake = createBrakeState();

  for (let i = 0; i < laps; i++) {
    if (retire && rng() < retireP) {
      result.retired = true;
      result.retiredLap = i + 1;
      break;
    }
    const lt = lapTime(perf, course, tire, driver, brake);
    let time = lt.time;
    if (noise) time *= 1 + sigma * gaussian(rng);

    result.laps.push({
      lap: i + 1, time, sectors: lt.sectors,
      wear: tire.wear, gripLoss: lt.gripLoss.total,
      brakeTemp: brake.temp, brakeFade: lt.brakeFade,
    });
    result.total += time;
    if (time < result.best) result.best = time;
    tire = advanceTire(tire, perf.stats);
    brake = advanceBrakes(brake, perf.stats, load);
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
