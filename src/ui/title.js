/**
 * タイトルの絵（canvas）。**PLiCy はページの最初の canvas からサムネイルを撮る**ので、
 * これが index.html の body の最初の要素になる。ここには絵と題だけを描き、
 * ボタンは canvas の外に HTML で置く。
 *
 * - 論理サイズは固定（TITLE.w × TITLE.h）。表示は CSS で伸縮させ、
 *   描画は devicePixelRatio ぶん上げる（サムネイルが潰れない）
 * - **画像が無くても成立する。** 地色と題だけ先に描き、画像が読めたら描き直す
 *   （PLiCy が早く撮っても真っ白にならない）
 * - 色は theme.css の変数から取る。canvas は変数を解釈しないので、読んで文字列にする
 * - 題字は同梱のサブセット（使う字だけ）。無い字は既定のゴシックへ落ちる
 */

/** 絵の大きさと、文字の置き方。**サムネイルの構図はここだけで決まる。** */
export const TITLE = {
  /** 写真が縦長（3:4）なので、絵も縦長の 4:5。**顔と足元の両方が入る形。** */
  w: 1200,
  h: 1500,
  /** 題の幅の上限（幅に対する割合）。左右中央揃えで、この幅に収める。 */
  band: 0.82,
  /** 左右の余白（論理 px）。 */
  pad: 44,
  /**
   * 板の下に置く**正式な題名**。ドットにしない、普通の字。
   * 読めることが第一なので、板の英語より小さくても字面を優先する。
   */
  jp: { text: 'ハルカのセッティングノート', size: 0.037, tracking: 0.06, gap: 0.26 },
  /** 題の下の帯（レーシングスーツの白赤）。幅は題に対する割合。 */
  stripe: { width: 0.3, red: 7, white: 3, gap: 5 },
  /**
   * 題を載せる電光掲示板（サーキットのタイミングボード）。
   * **ドットマトリクスの書体は同梱しない。** 画面外の canvas に普通に題を描き、
   * その画素を `pitch` おきに拾って、`threshold` を超えたところだけ丸で光らせる。
   *
   *   pitch      格子の間隔（論理 px）。字が潰れない下限がある
   *   lit / off  光るドットと消えているドットの半径（pitch に対する割合）
   *   threshold  光らせる濃さ（0〜1）
   *   padX/padY  板の内側の余白、radius 角の丸み、glow 滲みの強さ
   */
  board: {
    /** 板の中は**英数字だけ**。1行で入らなければ、最後の空白で2行に割る。 */
    text: "HARUKA'S SETTING NOTE",
    /** 字の大きさの上限（絵の高さに対する割合）と、ドットの行数の下限。 */
    maxSize: 0.062, minRows: 7.5,
    pitch: 9, lit: 0.34, off: 0.14, threshold: 0.55, tracking: 0.1,
    padX: 30, padY: 24, glow: 0.8, gap: 0.22,
    /**
     * 筐体まわり。**角は丸めない**（実物は角張っている）。
     *   outer/inner  外の太い枠と内の細い縁　bolt ボルトの頭の半径
     *   visor        上端の庇（ひさし）と、その下に落ちる影
     *   stripe/slots 下端の色帯（スポンサーの位置）と仕切りの数。**文字は入れない**
     *   mesh/scan    格子の目地と走査線　gloss アクリルの反射
     *   tilt         上辺をどれだけ広げるか（手前に傾いて見える。控えめに）
     *   leg*         足の付け根　shadow* 床に落ちる影
     */
    frame: {
      outer: 16, inner: 2, innerW: 2, bolt: 5,
      metalTop: '#4a5058', metal: '#2c3138', metalBottom: '#171b20',
      boltHi: '#b9c2cc', boltLo: '#5c656f',
      visor: 14, visorOut: 10, visorShade: 7,
      stripe: 22, slots: 6,
      mesh: 'rgba(0, 0, 0, .45)', scan: 'rgba(0, 0, 0, .22)', scanStep: 5,
      gloss: 0.075, glossAngle: 0.22,
      tilt: 0.018,
      legAt: 0.34, legW: 26, legH: 20, legFoot: 5,
      shadowBlur: 34, shadowY: 16,
    },
  },
  /**
   * 作り手の名前。**チェッカーフラッグ柄の帯に載せて、右下に貼ったように置く。**
   * size は絵の高さに対する文字の大きさ、square は市松1マス（文字の高さの半分）。
   * angle は傾き（度）、right / bottom は絵の端からの余白（幅・高さに対する割合）。
   */
  credit: {
    text: 'Produced by 夜中のBBQ',
    size: 0.0175, tracking: 0.08, square: 0.5,
    angle: 6, right: 0.04, bottom: 0.035, alpha: 0.92, seed: 20260914,
  },
  /** 題の下端を、絵の下からどれだけ上に置くか（高さに対する割合）。**下三分の一**。 */
  baseline: 0.1,
  /**
   * 絵の切り取り位置（0＝左/上、1＝右/下）。**下寄せ**。
   * 題は足元のコンクリートの上に置くので、下を切らない。余るぶんは上（天井）から切る。
   */
  focus: { x: 0.5, y: 0.9 },
  /** 下を暗くする幕。from から下が濃くなる（足元のコンクリートの上で白文字を読ませる）。 */
  veil: { alpha: 0.66, from: 0.5 },
  /** 画像のパス（index.html からの相対）。 */
  image: 'assets/title/haruka.jpg',
};

/** theme.css の変数を読む。無ければ控えの色（canvas は var() を解釈しない）。 */
function readColors(root = document.documentElement) {
  const css = getComputedStyle(root);
  const pick = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
  const rgba = (hex, a) => {
    const m = hex.replace('#', '').match(/../g)?.map((v) => parseInt(v, 16)) ?? [255, 255, 255];
    return `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${a})`;
  };
  const monText = pick('--mon-text', '#e8edf2');
  const monLit = pick('--mon-amber', '#ffb347');
  return {
    ground: pick('--ink', '#23211c'),      // 画像が無いときの地
    text: pick('--paper', '#f2efe6'),      // 紙の白
    accent: pick('--car', '#c62828'),      // 自車の赤。題の下の帯に一本だけ
    shade: pick('--ink-2', '#6b665c'),
    // 電光掲示板は画面の層の色。光る升と、消えている升と、滲み
    monBg: pick('--mon-bg', '#0a0d11'),
    monLine: pick('--mon-line', '#2a333d'),
    monText,
    monLit,
    monTextGlow: rgba(monText, 0.22),
    monLitGlow: rgba(monLit, 0.3),
    monLitHalo: rgba(monLit, 0.13),
    monOff: rgba(monLit, 0.1),
  };
}

/** 既定のゴシック。 */
const FONT = 'system-ui, "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", sans-serif';
/**
 * 板の下の日本語の題名。**いまは既定のゴシック。**
 * 同梱のサブセット（assets/fonts/dela-gothic-one-title.woff2、太くて角のある見出し用）に
 * 替えるなら、ここを `TITLE_FONT` にして weight を 400 にするだけ。
 */
const JP_FONT = FONT;
/** 同梱の見出し書体（いまは使っていない。theme.css に @font-face がある）。 */
const TITLE_FONT = '"Dela Gothic One", system-ui, "Yu Gothic UI", "Hiragino Sans", sans-serif';
/** ラテンだけは同梱の等幅（画面の層の書体）。assets/fonts/jetbrains-mono-latin.woff2 */
const MONO = '"JetBrains Mono", ui-monospace, Consolas, monospace';

/**
 * 題を描く。画像があってもなくても、同じ位置に同じ大きさで出る。
 * **絵の下三分の一。** 上から順に：
 *
 *   ┌────────────┐      電光掲示板（タイミングボード）。中は英数字だけ
 *   │  HARUKA'S      │      ドットで光らせる。作り方は drawBoard
 *   │  SETTING NOTE  │
 *   └────────────┘
 *   ハルカのセッティングノート   **正式な題名。** ドットにしない普通の字
 *        ▬▬               白と赤の帯（スーツの配色）
 *
 * 作り手の名前は別（drawSticker）。チェッカー柄の貼り紙にして右下に貼る。
 */
function drawText(ctx, colors, scale) {
  const inner = TITLE.w * TITLE.band - TITLE.pad * 2;
  const x = Math.round(TITLE.w / 2);
  const b = TITLE.board;

  // 板の中身（英数字）。1行で入って、ドットの行数も足りるならそのまま
  const board = boardLines(ctx, inner - b.padX * 2);
  const boardGap = Math.round(board.size * b.gap);
  const ledH = board.lines.length * board.size
    + (board.lines.length - 1) * boardGap + b.padY * 2;
  // 板の外寸＝庇＋枠＋LED面＋枠＋帯
  const boardH = b.frame.visor + b.frame.outer * 2 + ledH + b.frame.stripe;

  // 板の下の日本語。板より小さく
  const jpSize = Math.round(TITLE.h * TITLE.jp.size);
  const jpGap = Math.round(jpSize * TITLE.jp.gap * 2);
  const stripeH = TITLE.stripe.red + TITLE.stripe.gap + TITLE.stripe.white;
  const blockH = boardH + jpGap + jpSize + Math.round(jpSize * 0.55) + stripeH;
  const y = Math.round(TITLE.h * (1 - TITLE.baseline) - blockH);

  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  const shadow = (size) => {
    ctx.shadowColor = 'rgba(0, 0, 0, .8)';
    ctx.shadowBlur = Math.round(size * 0.28);
    ctx.shadowOffsetY = Math.round(size * 0.05);
  };

  /**
   * 1行引く。**字間を開けると canvas は右端にも同じ幅を足す**ので、
   * 中央揃えのときは半分だけ左に戻して、見た目の中心を合わせる。
   */
  const line = (text, size, ly, { font = FONT, weight = 700, track = 0, fill = null, stroke = 0.05, alpha = 1 } = {}) => {
    const spacing = Math.round(size * track);
    ctx.letterSpacing = `${spacing}px`;
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.globalAlpha = alpha;
    const cx = x - spacing / 2;
    shadow(size);
    ctx.lineWidth = Math.max(2, size * stroke);
    ctx.strokeStyle = 'rgba(0, 0, 0, .6)';
    ctx.strokeText(text, cx, ly);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = fill ?? colors.text;
    ctx.fillText(text, cx, ly);
    ctx.globalAlpha = 1;
    return ctx.measureText(text).width - spacing;
  };

  // 電光掲示板。渡すのは LED 面の位置（枠と庇はその外側に出る）
  drawBoard(ctx, colors, {
    x: Math.round(x - inner / 2), y: y + b.frame.visor + b.frame.outer,
    w: Math.round(inner), h: ledH,
    lines: board.lines, size: board.size, gap: boardGap,
  }, scale);

  // 正式な題名。白、中央、ドットにしない
  const jpY = y + boardH + jpGap;
  line(TITLE.jp.text, jpSize, jpY, { font: JP_FONT, weight: 700, track: TITLE.jp.tracking, stroke: 0.045 });

  // 白と赤の帯
  const stripeY = Math.round(jpY + jpSize + jpSize * 0.55);
  const stripeW = Math.round(inner * TITLE.stripe.width);
  ctx.save();
  shadow(jpSize * 0.4);
  ctx.fillStyle = colors.accent;
  ctx.fillRect(x - stripeW / 2, stripeY, stripeW, TITLE.stripe.red);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = colors.text;
  ctx.fillRect(x - stripeW / 2, stripeY + TITLE.stripe.red + TITLE.stripe.gap,
    stripeW, TITLE.stripe.white);
  ctx.restore();

  ctx.restore();
}

/**
 * 板に入れる行を決める。**1行に入るならそのまま、入らなければ最後の空白で2行**。
 * ドットの行数（字の高さ ÷ 格子）が足りない大きさなら、1行をあきらめて2行にする。
 */
function boardLines(ctx, maxWidth) {
  const b = TITLE.board;
  const max = Math.round(TITLE.h * b.maxSize);
  const fit = (text) => {
    let size = max;
    for (let i = 0; i < 60 && size > 8; i += 1) {
      ctx.letterSpacing = `${Math.round(size * b.tracking)}px`;
      ctx.font = `700 ${size}px ${MONO}`;
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= Math.max(1, Math.round(size * 0.04));
    }
    return size;
  };
  const one = fit(b.text);
  ctx.letterSpacing = '0px';
  if (one >= b.minRows * b.pitch) return { lines: [b.text], size: one };
  // 割るのは**最初の空白**（「HARUKA'S」／「SETTING NOTE」）
  const at = b.text.indexOf(' ');
  const parts = at > 0 ? [b.text.slice(0, at), b.text.slice(at + 1)] : [b.text];
  return { lines: parts, size: Math.min(...parts.map(fit)) };
}

/**
 * 電光掲示板（サーキットのタイミングボード）。**ドットの書体は同梱しない。**
 *
 *   1. 画面外の canvas に、等幅で英数字を普通に描く
 *   2. その画素を `pitch` おきに拾い、升の中でいちばん濃いところが `threshold` を超えたら光らせる
 *   3. 本番の canvas に、その升だけを丸で描く（消えている升もかすかに置く）
 *
 * 板そのものも画面外の canvas に組んでから、**上辺をわずかに広げて**貼る
 * （少しだけ手前に傾いて見える）。金属の枠・ボルト・庇・帯・足は `TITLE.board.frame`。
 * 色は画面の層（theme.css の `--mon-*`）と自車の赤（`--car`）。
 *
 * @param {object} geo LED 面の位置と大きさ（枠と庇はこの外側に出る）
 * @param {number} scale 画面の倍率（devicePixelRatio）
 */
function drawBoard(ctx, colors, geo, scale) {
  const b = TITLE.board;
  const f = b.frame;
  const { x, y, w, h, lines, size, gap } = geo;

  // パネル＝庇＋枠＋LED面＋帯。LED 面の左上が (f.outer, f.visor + f.outer)
  const panelW = w + f.outer * 2;
  const panelH = f.visor + f.outer * 2 + h + f.stripe;
  const px0 = x - f.outer;
  const py0 = y - f.visor - f.outer;

  const off = document.createElement('canvas');
  off.width = Math.round(panelW * scale);
  off.height = Math.round(panelH * scale);
  const o = off.getContext('2d', { willReadFrequently: true });
  o.setTransform(scale, 0, 0, scale, 0, 0);

  const ledX = f.outer;
  const ledY = f.visor + f.outer;

  // --- 金属の枠（角は丸めない。実物は角張っている） --------------------------
  const metal = o.createLinearGradient(0, py0 * 0 + f.visor, 0, panelH);
  metal.addColorStop(0, f.metalTop);
  metal.addColorStop(0.5, f.metal);
  metal.addColorStop(1, f.metalBottom);
  o.fillStyle = metal;
  o.fillRect(0, f.visor, panelW, panelH - f.visor);

  // 庇（ひさし）。板より少し広く張り出す
  o.fillStyle = f.metalTop;
  o.fillRect(-f.visorOut, 0, panelW + f.visorOut * 2, f.visor);
  o.fillStyle = 'rgba(0, 0, 0, .35)';
  o.fillRect(-f.visorOut, f.visor, panelW + f.visorOut * 2, f.visorShade);

  // --- LED 面 ---------------------------------------------------------------
  o.save();
  o.beginPath();
  o.rect(ledX, ledY, w, h);
  o.clip();
  o.fillStyle = colors.monBg;
  o.fillRect(ledX, ledY, w, h);

  // 目地（格子を一段暗く）と、かすかな縦の走査線
  o.strokeStyle = f.mesh;
  o.lineWidth = 1;
  for (let gx = 0; gx <= w; gx += b.pitch) {
    o.beginPath();
    o.moveTo(ledX + gx + 0.5, ledY);
    o.lineTo(ledX + gx + 0.5, ledY + h);
    o.stroke();
  }
  for (let gy = 0; gy <= h; gy += b.pitch) {
    o.beginPath();
    o.moveTo(ledX, ledY + gy + 0.5);
    o.lineTo(ledX + w, ledY + gy + 0.5);
    o.stroke();
  }
  o.fillStyle = f.scan;
  for (let sy = 0; sy < h; sy += f.scanStep) o.fillRect(ledX, ledY + sy, w, 1);

  // 題をドットに直す。拾うのは格子の升だけなので、下書きは論理サイズでよい
  const text = document.createElement('canvas');
  text.width = Math.round(w);
  text.height = Math.round(h);
  const t = text.getContext('2d', { willReadFrequently: true });
  t.textAlign = 'center';
  t.textBaseline = 'top';
  t.fillStyle = '#ffffff';
  const sp = Math.round(size * b.tracking);
  t.letterSpacing = `${sp}px`;
  t.font = `700 ${size}px ${MONO}`;
  lines.forEach((line, i) => {
    t.fillText(line, text.width / 2 - sp / 2, b.padY + i * (size + gap));
  });
  const data = t.getImageData(0, 0, text.width, text.height).data;
  /**
   * 升の濃さ（0〜1）。升の中を散らして拾い、**いちばん濃いところ**を採る。
   * 平均にすると、E の横棒のような細い画がまるごと消える。
   */
  const cover = (cx, cy) => {
    let max = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const sx = Math.round(cx + (dx * b.pitch) / 3);
        const sy2 = Math.round(cy + (dy * b.pitch) / 3);
        if (sx < 0 || sy2 < 0 || sx >= text.width || sy2 >= text.height) continue;
        max = Math.max(max, data[(sy2 * text.width + sx) * 4 + 3] / 255);
      }
    }
    return max;
  };

  const rLit = b.pitch * b.lit;
  const rOff = b.pitch * b.off;
  const lit = [];
  o.fillStyle = colors.monOff;
  for (let gy = b.pitch / 2; gy < h - 1; gy += b.pitch) {
    for (let gx = b.pitch / 2; gx < w - 1; gx += b.pitch) {
      if (cover(gx, gy) >= b.threshold) { lit.push([ledX + gx, ledY + gy]); continue; }
      o.beginPath();
      o.arc(ledX + gx, ledY + gy, rOff, 0, Math.PI * 2);
      o.fill();
    }
  }
  // 滲みは二段。外に大きく薄く、内に小さく濃く置いてから芯を打つ
  for (const [mul, fill] of [[1 + b.glow * 2, colors.monLitHalo], [1 + b.glow, colors.monLitGlow]]) {
    o.fillStyle = fill;
    for (const [gx, gy] of lit) {
      o.beginPath();
      o.arc(gx, gy, rLit * mul, 0, Math.PI * 2);
      o.fill();
    }
  }
  o.fillStyle = colors.monLit;
  for (const [gx, gy] of lit) {
    o.beginPath();
    o.arc(gx, gy, rLit, 0, Math.PI * 2);
    o.fill();
  }

  // アクリルのカバー。斜めの反射を一本だけ薄く
  o.save();
  o.translate(ledX, ledY);
  o.rotate(-f.glossAngle);
  const gl = o.createLinearGradient(0, -h, 0, h * 1.6);
  gl.addColorStop(0, 'rgba(255, 255, 255, 0)');
  gl.addColorStop(0.5, `rgba(255, 255, 255, ${f.gloss})`);
  gl.addColorStop(1, 'rgba(255, 255, 255, 0)');
  o.fillStyle = gl;
  o.fillRect(-w, h * 0.1, w * 3, h * 0.34);
  o.restore();
  o.restore();

  // LED 面の内側の細い縁（一段明るい金属）
  o.strokeStyle = f.inner;
  o.lineWidth = f.innerW;
  o.strokeRect(ledX - f.innerW / 2, ledY - f.innerW / 2, w + f.innerW, h + f.innerW);

  // --- 下端の帯（スポンサーの位置）。赤一本。**文字は入れない** ----------------
  const stripeY = ledY + h + f.outer * 0.35;
  o.fillStyle = colors.accent;
  o.fillRect(f.outer * 0.6, stripeY, panelW - f.outer * 1.2, f.stripe * 0.62);
  // 帯の中の小さな欄（仕切りだけ。数字は出さない）
  o.fillStyle = 'rgba(0, 0, 0, .35)';
  const slots = f.slots;
  const slotW = (panelW - f.outer * 1.2) / slots;
  for (let i = 1; i < slots; i += 1) {
    o.fillRect(f.outer * 0.6 + slotW * i - 1, stripeY, 2, f.stripe * 0.62);
  }

  // --- ボルトの頭 -------------------------------------------------------------
  const r = f.bolt;
  const bx = [f.outer / 2, panelW / 2, panelW - f.outer / 2];
  const by = [f.visor + f.outer / 2, panelH - f.stripe - f.outer / 2];
  for (const cx of bx) {
    for (const cy of by) {
      o.beginPath();
      o.arc(cx, cy + 1, r, 0, Math.PI * 2);
      o.fillStyle = 'rgba(0, 0, 0, .55)';
      o.fill();
      const g2 = o.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      g2.addColorStop(0, f.boltHi);
      g2.addColorStop(1, f.boltLo);
      o.beginPath();
      o.arc(cx, cy, r, 0, Math.PI * 2);
      o.fillStyle = g2;
      o.fill();
    }
  }

  // --- 足（付け根だけ）と、床に落ちる影 ---------------------------------------
  ctx.save();
  ctx.fillStyle = f.metalBottom;
  const legTop = y + h + f.outer + f.stripe - 2;
  for (const s2 of [-1, 1]) {
    const lx = x + w / 2 + s2 * w * f.legAt - f.legW / 2;
    // 付け根だけ。床に置かれているのが分かればよく、全部は描かない
    ctx.beginPath();
    ctx.moveTo(lx, legTop);
    ctx.lineTo(lx + f.legW, legTop);
    ctx.lineTo(lx + f.legW + f.legFoot, legTop + f.legH);
    ctx.lineTo(lx - f.legFoot, legTop + f.legH);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, .75)';
  ctx.shadowBlur = f.shadowBlur;
  ctx.shadowOffsetY = f.shadowY;
  ctx.fillStyle = 'rgba(0, 0, 0, .9)';
  ctx.fillRect(px0 + 8, py0 + 10, panelW - 16, panelH - 12);
  ctx.restore();

  // --- 貼る。**上辺をわずかに広げる**（少しだけ手前に傾いて見える） -------------
  drawTilted(ctx, off, px0 + panelW / 2, py0, panelW, panelH, f.tilt);
}

/** 上辺だけ広げて貼る。1行ずつ幅を変えて描くので、傾きが強くても字が割れない。 */
function drawTilted(ctx, img, cx, top, w, h, tilt) {
  const rows = Math.max(1, Math.round(h));
  const sh = img.height / rows;
  for (let i = 0; i < rows; i += 1) {
    const rw = w * (1 + tilt * (1 - i / rows));
    ctx.drawImage(img, 0, i * sh, img.width, sh + 1, cx - rw / 2, top + i, rw, 1.6);
  }
}

/** 同じ絵を何度描いても同じになるように、種を決めた乱数を使う（mulberry32）。 */
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 作り手の名前を、**チェッカーフラッグ柄の貼り紙**にして右下に貼る。
 *
 * - 市松は canvas に直接描く（画像は足さない）。1マスは文字の高さの半分
 * - 文字は帯の真ん中に白い欄を作って、そこに黒で入れる
 * - 別の canvas に組んでから、**縁を荒らして**斜めに貼る。薄い影で浮かせる
 * - 題字とは重ならない（題字は中央、これは右下）
 *
 * @param {number} scale 画面の倍率（devicePixelRatio）。荒れも文字も潰さない
 */
function drawSticker(ctx, colors, scale) {
  const c = TITLE.credit;
  const fs = Math.round(TITLE.h * c.size);
  const sq = Math.max(3, Math.round(fs * c.square));     // 市松1マス
  const track = Math.round(fs * c.tracking);

  // 文字の幅を測って、マスの倍数の帯にする
  ctx.save();
  ctx.font = `400 ${fs}px ${MONO}, ${FONT}`;
  ctx.letterSpacing = `${track}px`;
  const textW = ctx.measureText(c.text).width - track;
  ctx.restore();
  const w = Math.ceil((textW + sq * 3) / sq) * sq;
  const labelH = Math.round(fs * 1.6);
  const h = labelH + sq * 2;

  // 貼り紙そのものは別の canvas に組む（縁を荒らすのに要る）
  const off = document.createElement('canvas');
  off.width = Math.round(w * scale);
  off.height = Math.round(h * scale);
  const o = off.getContext('2d');
  o.setTransform(scale, 0, 0, scale, 0, 0);

  // 市松（白黒）。帯の上下の1列ぶん
  o.fillStyle = '#ffffff';
  o.fillRect(0, 0, w, h);
  o.fillStyle = '#111111';
  for (let row = 0; row < Math.ceil(h / sq); row += 1) {
    for (let col = 0; col < w / sq; col += 1) {
      if ((row + col) % 2 === 0) o.fillRect(col * sq, row * sq, sq, sq);
    }
  }
  // 真ん中の欄。ここに文字を入れる
  o.fillStyle = '#f4f2ec';
  o.fillRect(0, sq, w, labelH);
  o.fillStyle = '#111111';
  o.font = `400 ${fs}px ${MONO}, ${FONT}`;
  o.letterSpacing = `${track}px`;
  o.textAlign = 'center';
  o.textBaseline = 'middle';
  o.fillText(c.text, w / 2 - track / 2, sq + labelH / 2 + 1);

  // 縁を荒らす。**同じ種なので、描き直しても同じ荒れ方になる**
  const rnd = rngFrom(c.seed);
  o.globalCompositeOperation = 'destination-out';
  const bites = Math.round((w + h) / sq);
  for (let i = 0; i < bites; i += 1) {
    const edge = Math.floor(rnd() * 4);
    const r = sq * (0.25 + rnd() * 0.5);
    const along = rnd();
    const px = edge === 0 || edge === 2 ? along * w : (edge === 1 ? w : 0);
    const py = edge === 1 || edge === 3 ? along * h : (edge === 2 ? h : 0);
    o.beginPath();
    o.arc(px, py, r, 0, Math.PI * 2);
    o.fill();
  }
  // 四隅は少し大きく欠く
  for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    o.beginPath();
    o.arc(cx, cy, sq * (0.5 + rnd() * 0.4), 0, Math.PI * 2);
    o.fill();
  }
  o.globalCompositeOperation = 'source-over';

  // 貼る。右下、斜め、薄い影で浮かせる
  const cx = TITLE.w * (1 - c.right) - w / 2;
  const cy = TITLE.h * (1 - c.bottom) - h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((c.angle * Math.PI) / 180);
  ctx.shadowColor = 'rgba(0, 0, 0, .5)';
  ctx.shadowBlur = Math.round(sq * 1.6);
  ctx.shadowOffsetY = Math.round(sq * 0.5);
  ctx.globalAlpha = c.alpha;
  ctx.drawImage(off, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/** 下を暗くする幕。足元のコンクリートが明るくても題が読める。 */
function drawVeil(ctx) {
  const g = ctx.createLinearGradient(0, TITLE.h * TITLE.veil.from, 0, TITLE.h);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(0.55, `rgba(0, 0, 0, ${TITLE.veil.alpha * 0.55})`);
  g.addColorStop(1, `rgba(0, 0, 0, ${TITLE.veil.alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, TITLE.h * TITLE.veil.from, TITLE.w, TITLE.h * (1 - TITLE.veil.from));
}

/** 絵を切り取って敷く（object-fit: cover と同じ。focus の点を残す）。 */
function drawImage(ctx, img) {
  const scale = Math.max(TITLE.w / img.naturalWidth, TITLE.h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const dx = (TITLE.w - dw) * TITLE.focus.x;
  const dy = (TITLE.h - dh) * TITLE.focus.y;
  ctx.drawImage(img, dx, dy, dw, dh);
}

/**
 * canvas にタイトルを描く。**すぐに地色と題を描き**、画像が読めたら描き直す。
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts { src } 画像のパス（省略時は TITLE.image）
 * @returns {Promise<boolean>} 画像まで描けたか
 */
export async function mountTitle(canvas, opts = {}) {
  const colors = readColors();
  const scale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  canvas.width = Math.round(TITLE.w * scale);
  canvas.height = Math.round(TITLE.h * scale);
  const ctx = canvas.getContext('2d');

  const paint = (img) => {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, TITLE.w, TITLE.h);
    ctx.fillStyle = colors.ground;
    ctx.fillRect(0, 0, TITLE.w, TITLE.h);
    if (img) { drawImage(ctx, img); drawVeil(ctx); }
    drawText(ctx, colors, scale);
    drawSticker(ctx, colors, scale);
  };

  paint(null);   // 画像も書体も待たずに、まず題まで描く

  // 同梱の等幅は、canvas からは読み込みが始まらない。**先に呼んでおく**
  // （間に合わなければ既定の等幅で出る。位置も大きさも変わらない）
  const font = Promise.all([
    document.fonts?.load(`400 ${Math.round(TITLE.h * 0.02)}px "JetBrains Mono"`, TITLE.credit.text),
    document.fonts?.load(`700 ${Math.round(TITLE.h * 0.06)}px "JetBrains Mono"`, TITLE.board.text),
  ].filter(Boolean)).catch(() => null);

  const src = opts.src ?? TITLE.image;
  let img = null;
  try {
    if (src) {
      img = new Image();
      img.src = src;
      await img.decode();
    }
  } catch {
    // 画像が無い・壊れている。**地色と題だけで成立する**ので、絵なしで描き直す
    img = null;
  }
  await font;
  paint(img);
  return !!img;
}
