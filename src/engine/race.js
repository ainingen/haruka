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

  /**
   * 燃料。単位は無次元で、1単位がそのまま weight の1ポイントになる。
   * リッターではなく「重さに換算できる量」として持つ（換算は表示側の KG_PER_POINT）。
   *
   * 値は「レース序盤と終盤で1秒/周ほど変わる」ように決めてある。満タンが速さの足かせになり、
   * 軽くなりながら速くなる。積みすぎても足かせ、足りなければ止まる。
   */
  fuel: {
    /** fuel_consumption = 0 の車が1周で使う量 */
    perLapBase: 1.8,
    /** fuel_consumption 1ポイントあたり、1周の消費が何割増えるか */
    perPoint: 0.05,
    /** 燃料1単位あたり weight に加算されるポイント数 */
    weightPerUnit: 1,
    /** 積むときの余裕（必要量の何割を上乗せするか） */
    margin: 0.08,
    /** タンクの上限。これを超える距離は、途中で給油しないと走り切れない */
    tankMax: 100,
  },
};

/**
 * 無線（docs/設計/無線.md）。判定の条件と抑制はここに集約する。
 * **台詞は持たない。** トリガー ID だけを返し、文言は data/radio.json から UI が選ぶ。
 */
export const RADIO = {
  /**
   * 情報系の優先順。1周に出せる本数（maxInfoPerLap）を超えたら、後ろのものは次の周に回る。
   * 先頭の `fuel_out` だけは別格で、立ったらこの1本しか出さない（下の exclusive を参照）。
   */
  priority: [
    'fuel_out', 'retire_sign', 'fuel_low', 'brake_fade', 'tire_wear', 'understeer', 'oversteer',
    'cold_tire', 'straight_loss', 'corner_loss', 'overtaken', 'overtake', 'good_lap',
  ],
  /** 立ったら他を全部押しのけるトリガー。止まった車のアンダーステアを報告しても仕方がない */
  exclusive: ['fuel_out'],
  /** 燃料の残りがこの周回数を切ったら「燃料、足りる？」 */
  fuelLowLaps: 3,
  /** 出来事（抜いた・抜かれた・好調）。症状ではないので、繰り返しの抑制をかけない */
  events: ['overtake', 'overtaken', 'good_lap'],
  /** 1周あたりのリタイア確率がこれを超えたら「嫌な音がする」 */
  retireRisk: 0.005,
  /** ブレーキ温度がフェード閾値のこの割合を超えたら */
  fadeRatio: 0.9,
  /** 摩耗によるグリップ低下が「使い切り」（gripLossAtFullWear）のこの割合を超えたら */
  wearRatio: 0.25,
  /** 好みからの balance のズレがこれ以上なら アンダー／オーバー */
  balanceDev: 3,
  /** 症状が続いている間、何周おきに繰り返して言うか */
  repeatLaps: 2,
  /** 深刻さがこの倍率を超えて悪化したら、周を待たずに言い、口調がきつくなる */
  worsen: 1.15,
  /** 同じ症状を何回目から、きつい口調（harsh）で言うか */
  harshAfter: 3,
  /** 1周に出す情報系の上限 */
  maxInfoPerLap: 2,
  /** 雑談：情報系が立たなかった周に出す確率、1レースの上限、雑談どうしの最小間隔（周） */
  chat: { chance: 0.35, max: 6, gapLaps: 1 },
  /** セクター通過ごとの反応：出す確率と、ベストに対して「良かった／悪かった」とみなす比率 */
  reaction: { chance: 0.6, goodMargin: 0.002, badMargin: 0.006 },
  /** 常時層（ピットからの自動コールなど）：1倍速での間隔（走行秒）と、4倍速で何倍に間引くか */
  constant: { intervalSec: 9, thinAtFast: 3 },

  /**
   * ピットでの一言（セッティング画面）。無線とは別枠。
   *
   * バランスのズレを先に言い、好みどおりに収まっているときだけスタビの片側装着に触れる
   * （片側だけでも狙ってバランスを取っているなら、それは文句の対象ではない）。
   */
  pit: {
    priority: [
      'too_demanding', 'pressure_high', 'quali_pressure_ok', 'understeer', 'oversteer',
      'stabi_front_only', 'stabi_rear_only', 'just_right',
    ],
    /** 好みからの balance のズレがこれ以上なら口を出す（無線より早い段階で言う） */
    balanceDev: 1.5,
    /** これ以上の空気圧は「予選用？」 */
    pressureHigh: 2.35,
    /** driver_demand がこれ以上で、技量が demandSkillRef に届いていないとき */
    demand: 6,
  },
};

/**
 * 予選（docs/設計/レース方式.md）。計測3周：アウトラップ → アタック → インラップ。ベストラップで並ぶ。
 * アウト／インは流すので係数で遅くする。アタックは決勝と同じ計算（冷間のグリップ低下もそのまま効く）。
 */
export const QUALI = {
  laps: 3,
  attackLap: 2,
  /** アウトラップとインラップの速度係数（1 未満＝流す） */
  outLapFactor: 0.94,
  inLapFactor: 0.90,
};

/**
 * スタート直後の混雑。グリッド順に並び、前の車が近いほど最初の数セクターで遅くなる。
 * 予選を走らなければ最後尾なので、この分だけ確実に払う。
 */
export const START = {
  /** グリッド1列ごとのスタート遅れ（秒） */
  slotDelay: 0.5,
  /** 混雑ペナルティが効くセクター数（周の頭から） */
  sectors: 2,
  /** 前車との差がこの秒数以内ならブロックされる */
  gapSec: 1.0,
  /** 差 0 のときの速度低下率 */
  maxLoss: 0.15,
};

/** 前車との差（秒）→ 速度係数。差が gapSec 以上なら 1（影響なし）。 */
export function gridBlockFactor(gapSec) {
  const g = Math.max(0, gapSec);
  return 1 - START.maxLoss * Math.max(0, 1 - g / START.gapSec);
}

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
  return Math.max(0, brake.temp - brakeThreshold(stats)) * WEIGHTS.brake.lossPerDegree;
}

// ---------------------------------------------------------------------------
// 燃料
//
// 積んだ燃料はそのまま重さになる。満タンで出て、減りながら速くなる。
// 途中で足せるのはピットだけ（refuel）。空になったら走れない。
// ---------------------------------------------------------------------------

/** 1周で使う量。fuel_consumption が高いほど増える。 */
export function fuelPerLap(stats) {
  const F = WEIGHTS.fuel;
  return F.perLapBase * (1 + F.perPoint * Math.max(0, stats.fuel_consumption));
}

/** その距離を走るために積む量。余裕を足し、タンクの上限で頭打ちになる。 */
export function fuelForLaps(stats, laps) {
  const F = WEIGHTS.fuel;
  return Math.min(F.tankMax, fuelPerLap(stats) * laps * (1 + F.margin));
}

/** 出走時の燃料。laps はそのセッションで走る予定の周回数。 */
export function createFuelState(stats, laps) {
  const level = fuelForLaps(stats, laps);
  return { level, filled: level };
}

/** いま積んでいる燃料が weight に足すポイント数。 */
export const fuelWeight = (fuel) => (fuel ? fuel.level * WEIGHTS.fuel.weightPerUnit : 0);

/** あと何周ぶん残っているか（表示用）。 */
export const fuelLapsLeft = (fuel, stats) => (fuel ? fuel.level / fuelPerLap(stats) : Infinity);

/** 1周ぶん減らす。0 未満にはしない。 */
export function advanceFuel(fuel, stats) {
  return { ...fuel, level: Math.max(0, fuel.level - fuelPerLap(stats)) };
}

/** この周を走り切れるか。走り切れないまま周に入ると燃料切れでリタイアになる。 */
export const canRunLap = (fuel, stats) => !fuel || fuel.level >= fuelPerLap(stats);

/**
 * 給油。**ピットでのみ呼ぶ。** 走行中に燃料が増える経路は他に無い。
 * ピットストップ自体はまだ実装していないので、いまこれを呼ぶのは将来の耐久レースだけ。
 */
export function refuel(fuel, stats, laps) {
  return { ...fuel, level: fuelForLaps(stats, laps), filled: fuelForLaps(stats, laps) };
}

// ---------------------------------------------------------------------------
// セクター通過時間
// ---------------------------------------------------------------------------

/**
 * タイヤ・ブレーキ・燃料の状態を反映した実効性能。セクター計算はこれを見る。
 * 燃料はばね上の重さなので、セクター種別によらず同じだけ weight_eff に乗る。
 */
export function effectiveStats(perf, tire, brake = createBrakeState(), fuel = null) {
  const loss = tireGripLoss(perf.stats, tire);
  const fw = fuelWeight(fuel);
  return {
    ...perf.stats,
    cornering_grip: perf.stats.cornering_grip - loss.total,
    traction: perf.stats.traction - loss.total * WEIGHTS.tire.tractionShare,
    braking: perf.stats.braking - brakeFadeLoss(perf.stats, brake),
    weight_eff: fw
      ? Object.fromEntries(SECTOR_TYPES.map((t) => [t, perf.weightEff[t] + fw]))
      : perf.weightEff,
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
export function lapTime(perf, course, tire, driver, brake = createBrakeState(), fuel = null) {
  const eff = effectiveStats(perf, tire, brake, fuel);
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
// 無線（docs/設計/無線.md）
//
// 判定はここだけで行い、UI は結果（トリガー ID）を受け取って台詞を選ぶだけにする。
// ハルカは計器を読んでいない。症状だけを言い、原因も対策も言わない。
// ---------------------------------------------------------------------------

/** 無線の状態。1レースにつき1つ作って周回をまたいで持ち回る。 */
export function createRadioState() {
  return { fired: {}, chats: 0, lastChatLap: -99, lastLap: -99, calls: [] };
}

/**
 * その周に立っている症状と、その深刻さ。
 *
 * 深刻さは「1.0 でちょうど閾値」に正規化した値。同じトリガーの2回目を許すかどうかの
 * 判断（悪化したか）にこの値を使う。
 *
 * @param {object} perf buildPerformance の戻り値
 * @param {object} snapshot
 *   @param {number} snapshot.lap      これから数える周（1始まり）
 *   @param {object} snapshot.tire     その周を走ったときのタイヤ状態
 *   @param {object} snapshot.brake    その周を走ったときのブレーキ状態
 *   @param {object} snapshot.driver   drivers.json の要素
 *   @param {number} [snapshot.lapTime]  その周のタイム
 *   @param {number} [snapshot.bestTime] その周より前の自己ベスト
 *   @param {object} [snapshot.traffic]  { straightLoss, cornerLoss, overtook, overtaken }
 *                                       順位と相対速度は UI 側にしか無いので受け取る
 *   @param {object} [snapshot.fuel]    その周を終えた時点の燃料状態
 *   @param {boolean} [snapshot.stopped] 燃料切れで止まった。呼び出し側だけが知っている
 */
export function radioSymptoms(perf, snapshot) {
  const { tire, brake, driver, lapTime, bestTime, traffic = {}, fuel } = snapshot;
  const stats = perf.stats;
  const out = {};

  // 止まったかどうかは残量からは決められない（1周ぶんを切った状態でゴールすることもある）。
  // 実際にリタイアさせた側が stopped を立てる
  if (snapshot.stopped) out.fuel_out = 1;
  else if (fuel) {
    const left = fuelLapsLeft(fuel, stats);
    // 「残りが3周分を切った」だけだと、余裕を持って走り切る周でも毎レース終盤に言うことになる。
    // 残り周回に足りないと分かったときだけ言う（lapsToGo を渡さなければ前者だけで判定する）
    const toGo = snapshot.lapsToGo ?? Infinity;
    if (left < RADIO.fuelLowLaps && left < toGo) out.fuel_low = RADIO.fuelLowLaps / Math.max(left, 0.05);
  }

  const retireP = WEIGHTS.reliability.retirePerPointPerLap * Math.max(0, -stats.reliability);
  if (retireP >= RADIO.retireRisk) out.retire_sign = retireP / RADIO.retireRisk;

  const heat = brake.temp / (brakeThreshold(stats) * RADIO.fadeRatio);
  if (heat >= 1) out.brake_fade = heat;

  const loss = tireGripLoss(stats, tire);
  const worn = loss.worn / WEIGHTS.tire.gripLossAtFullWear / RADIO.wearRatio;
  if (worn >= 1) out.tire_wear = worn;

  const dev = stats.balance - (driver?.preferred_balance ?? 0);
  if (dev <= -RADIO.balanceDev) out.understeer = -dev / RADIO.balanceDev;
  else if (dev >= RADIO.balanceDev) out.oversteer = dev / RADIO.balanceDev;

  if (loss.cold > 0) out.cold_tire = loss.cold / WEIGHTS.tire.coldGripLoss;

  if (traffic.straightLoss) out.straight_loss = 1;
  if (traffic.cornerLoss) out.corner_loss = 1;
  if (traffic.overtaken) out.overtaken = 1;
  if (traffic.overtook) out.overtake = 1;

  // 好調は「他に何も起きていない周の自己ベスト更新」だけ。だから軽く扱われない。
  const clean = Object.keys(out).length === 0;
  if (clean && Number.isFinite(lapTime) && Number.isFinite(bestTime) && lapTime < bestTime) out.good_lap = bestTime / lapTime;

  return out;
}

/**
 * その周に出す情報系の無線を決める。配列で返す（出さない周は空）。
 *
 * 症状は続いている間くり返し言う（repeatLaps ごと）。悪化したときは待たずに言い、
 * 口調がきつくなる（level: 'harsh'）。同じ症状を harshAfter 回目からもきつく言う。
 * 出来事（抜いた・抜かれた・好調）は抑制なし。情報系が何も無ければ、確率で雑談を1本。
 *
 * state は呼び出し側が持ち回る（この関数が書き換える）。
 */
export function radioForLap(perf, snapshot, state, rng = Math.random) {
  const lap = snapshot.lap;
  const symptoms = radioSymptoms(perf, snapshot);
  const calls = [];

  // 押しのけるトリガー（燃料切れ）が立ったら、この1本だけ。上限も繰り返しの抑制も関係ない
  const exclusive = RADIO.exclusive.find((id) => symptoms[id] !== undefined);
  if (exclusive) {
    const count = (state.fired[exclusive]?.count ?? 0) + 1;
    state.fired[exclusive] = { count, lap, severity: symptoms[exclusive] };
    state.lastLap = lap;
    const call = { lap, id: exclusive, kind: 'info', severity: symptoms[exclusive], level: 'normal', count };
    state.calls.push(call);
    return [call];
  }

  for (const id of RADIO.priority) {
    const severity = symptoms[id];
    if (severity === undefined) continue;
    if (calls.length >= RADIO.maxInfoPerLap) break;

    const prev = state.fired[id];
    const isEvent = RADIO.events.includes(id);
    let level = 'normal';
    if (prev && !isEvent) {
      const worse = severity > prev.severity * RADIO.worsen;
      // 症状が続いていても毎周は言わない。悪化したときだけ待たずに言う
      if (!worse && lap < prev.lap + RADIO.repeatLaps) continue;
      if (worse || prev.count + 1 >= RADIO.harshAfter) level = 'harsh';
    } else if (prev && isEvent && prev.count + 1 >= RADIO.harshAfter) {
      level = 'harsh';   // 「また抜かれた」
    }
    const count = (prev?.count ?? 0) + 1;
    state.fired[id] = { count, lap, severity: Math.max(severity, prev?.severity ?? 0) };
    state.lastLap = lap;
    const call = { lap, id, kind: 'info', severity, level, count };
    state.calls.push(call);
    calls.push(call);
  }

  // 雑談。情報系が立たなかった周の隙間に。
  const C = RADIO.chat;
  if (!calls.length && state.chats < C.max && lap > state.lastChatLap + C.gapLaps && rng() < C.chance) {
    state.chats += 1;
    state.lastChatLap = lap;
    state.lastLap = lap;
    const call = { lap, id: 'chat', kind: 'chat', severity: 0, level: 'normal', count: state.chats };
    state.calls.push(call);
    calls.push(call);
  }
  return calls;
}

/**
 * セクターを1つ抜けるたびのハルカの反応。「よし」「ちっ」の類。出さないときは null。
 *
 * その車の同じセクターのベストと比べて、並んでいれば good、目に見えて遅ければ bad。
 * ベストがまだ無い（1周目）なら neutral。数字は返さない——ハルカは計器を読まない。
 *
 * @param {{ type: string, time: number, best: number }} sector
 * @param {function} rng
 * @param {number} [chance] 出す確率（倍速時は間引くために下げる）
 */
export function reactionFor(sector, rng = Math.random, chance = RADIO.reaction.chance) {
  if (rng() >= chance) return null;
  const R = RADIO.reaction;
  let sentiment = 'neutral';
  if (Number.isFinite(sector.best) && sector.best > 0) {
    const d = (sector.time - sector.best) / sector.best;
    if (d <= R.goodMargin) sentiment = 'good';
    else if (d >= R.badMargin) sentiment = 'bad';
  }
  return { sentiment, type: sector.type };
}

// ---------------------------------------------------------------------------
// 車両情報パネル用の値。計算には使わない表示専用のものも含む（その旨を各所に書く）。
// ---------------------------------------------------------------------------

/** フェードが始まるブレーキ温度。 */
export function brakeThreshold(stats) {
  const B = WEIGHTS.brake;
  return B.thresholdBase + B.thresholdPerFadeResistance * stats.fade_resistance;
}

/**
 * タイヤ摩耗の前後配分（表示用）。
 * 計算上の摩耗は1つの値だが、アンダーの車は前を、オーバーの車は後ろを余計に削るので、
 * balance のズレに応じて前後に振り分けて見せる。合計の意味は変えない。
 */
export function tireWearSplit(perf, tire, driver) {
  const dev = perf.stats.balance - (driver?.preferred_balance ?? 0);
  const skew = Math.min(0.5, Math.abs(dev) * 0.08);
  const front = tire.wear * (1 + (dev < 0 ? skew : -skew));
  const rear = tire.wear * (1 + (dev > 0 ? skew : -skew));
  return { front, rear };
}

/** 燃料の残量（0〜1、表示用）。満タンに対する割合。 */
export const fuelLevel = (fuel) => (fuel && fuel.filled > 0 ? fuel.level / fuel.filled : 0);

/**
 * セッティング画面での一言（無線とは別枠のピット会話）。ID を1つ返す。言うことが無ければ null。
 *
 * @param {object} perf    buildPerformance の戻り値
 * @param {object} driver  drivers.json の要素
 * @param {object} [context]
 *   @param {object[]} [context.parts]     装着中のパーツ（スタビの片側判定に使う）
 *   @param {object}   [context.settings]  連続値セッティング（空気圧を見る）
 */
export function pitComment(perf, driver, context = {}) {
  const { parts = [], settings = {} } = context;
  const stats = perf.stats;
  const P = RADIO.pit;
  const said = {};

  if (stats.driver_demand >= P.demand && (driver?.skill ?? 100) < WEIGHTS.driver.demandSkillRef) {
    said.too_demanding = true;
  }
  const pressure = settings.tire_pressure;
  if (pressure !== undefined && pressure !== null && pressure >= P.pressureHigh) {
    // 予選なら高めは正解。一発ならそれでいい、と言う
    said[context.session === 'quali' ? 'quali_pressure_ok' : 'pressure_high'] = true;
  }

  const slots = new Set(parts.flatMap(occupiedSlots));
  if (slots.has('stabi_front') && !slots.has('stabi_rear')) said.stabi_front_only = true;
  if (slots.has('stabi_rear') && !slots.has('stabi_front')) said.stabi_rear_only = true;

  const dev = stats.balance - (driver?.preferred_balance ?? 0);
  if (dev <= -P.balanceDev) said.understeer = true;
  else if (dev >= P.balanceDev) said.oversteer = true;
  else said.just_right = true;

  return RADIO.pit.priority.find((id) => said[id]) ?? null;
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
  const { seed = 1, noise = true, retire = true, radio = false } = options;
  const rng = createRng(seed);
  // 無線の乱数は別系統。無線を切ったときと走行結果が変わらないようにする。
  const radioRng = createRng(seed + 101);
  const radioState = radio ? createRadioState() : null;
  const sigma = WEIGHTS.driver.noiseAtZeroConsistency * (100 - (driver?.consistency ?? 100)) / 100;
  const retireP = WEIGHTS.reliability.retirePerPointPerLap * Math.max(0, -perf.stats.reliability);

  const load = courseLoad(course);
  const result = {
    courseId: course.id, laps: [], total: 0, best: Infinity,
    retired: false, retiredLap: null, retireReason: null,
    radio: radio ? [] : null,
  };
  let tire = createTireState();
  let brake = createBrakeState();
  let fuel = createFuelState(perf.stats, laps);

  for (let i = 0; i < laps; i++) {
    // 燃料切れは運ではないので、リタイア判定を切っていても止まる
    if (!canRunLap(fuel, perf.stats)) {
      result.retired = true;
      result.retiredLap = i + 1;
      result.retireReason = 'fuel';
      if (radioState) {
        result.radio.push(...radioForLap(
          perf, { lap: i + 1, tire, brake, fuel, driver, stopped: true }, radioState, radioRng,
        ));
      }
      break;
    }
    if (retire && rng() < retireP) {
      result.retired = true;
      result.retiredLap = i + 1;
      result.retireReason = 'reliability';
      break;
    }
    const lt = lapTime(perf, course, tire, driver, brake, fuel);
    let time = lt.time;
    if (noise) time *= 1 + sigma * gaussian(rng);

    const entry = {
      lap: i + 1, time, sectors: lt.sectors,
      wear: tire.wear, gripLoss: lt.gripLoss.total,
      brakeTemp: brake.temp, brakeFade: lt.brakeFade,
      fuel: fuel.level,          // その周を走ったときの量
    };
    // 燃料だけは「走り終えた時点」で見る。ハルカが周の終わりにメーターを見るのと同じ
    const nextFuel = advanceFuel(fuel, perf.stats);
    if (radioState) {
      // 順位の絡む症状（直線／コーナーで負け、抜いた・抜かれた）は1台走行では立たない
      entry.radio = radioForLap(
        perf,
        { lap: i + 1, tire, brake, fuel: nextFuel, lapsToGo: laps - (i + 1), driver, lapTime: time, bestTime: result.best },
        radioState, radioRng,
      );
      result.radio.push(...entry.radio);
    }
    result.laps.push(entry);
    result.total += time;
    if (time < result.best) result.best = time;
    tire = advanceTire(tire, perf.stats);
    brake = advanceBrakes(brake, perf.stats, load);
    fuel = nextFuel;
  }
  result.average = result.laps.length ? result.total / result.laps.length : NaN;
  result.fuelLeft = fuel.level;
  return result;
}

/**
 * 予選を1台走らせる。アウトラップ → アタック → インラップ。
 * 戻り値の best がグリッド順の根拠。attack はアタックラップの詳細。
 *
 * @param {object} perf    buildPerformance の戻り値（予選用セッティングで組む）
 * @param {object} course  courses.json の要素
 * @param {object} driver  drivers.json の要素
 * @param {object} [options] { seed, noise } — simulateRace と同じ
 */
export function simulateQualifying(perf, course, driver, options = {}) {
  const { seed = 1, noise = true } = options;
  const rng = createRng(seed + 31);
  const sigma = WEIGHTS.driver.noiseAtZeroConsistency * (100 - (driver?.consistency ?? 100)) / 100;
  const load = courseLoad(course);
  let tire = createTireState();
  let brake = createBrakeState();
  // 予選は計測3周ぶんしか積まない。決勝より軽いぶん速いのは、そういう理由
  let fuel = createFuelState(perf.stats, QUALI.laps);
  const laps = [];
  for (let i = 0; i < QUALI.laps; i++) {
    const lapNo = i + 1;
    const factor = lapNo < QUALI.attackLap ? 1 / QUALI.outLapFactor
      : lapNo > QUALI.attackLap ? 1 / QUALI.inLapFactor : 1;
    const lt = lapTime(perf, course, tire, driver, brake, fuel);
    let time = lt.time * factor;
    if (noise) time *= 1 + sigma * gaussian(rng);
    laps.push({ lap: lapNo, time, kind: lapNo < QUALI.attackLap ? 'out' : lapNo > QUALI.attackLap ? 'in' : 'attack', wear: tire.wear, gripLoss: lt.gripLoss.total, fuel: fuel.level });
    tire = advanceTire(tire, perf.stats);
    brake = advanceBrakes(brake, perf.stats, load);
    fuel = advanceFuel(fuel, perf.stats);
  }
  const best = Math.min(...laps.map((l) => l.time));
  return { courseId: course.id, laps, best, attack: laps[QUALI.attackLap - 1] };
}

/** 秒 → "m:ss.mmm" */
export function formatTime(sec) {
  if (!Number.isFinite(sec)) return '--:--.---';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
