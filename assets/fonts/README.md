# assets/fonts

数字・ラテン・記号のための等幅フォント。**同梱して `@font-face` でローカル参照する。**
CDN からの読み込みは禁止（PLiCy 公開の制約。`CLAUDE.md`）。

| ファイル | 中身 |
|---|---|
| `jetbrains-mono-latin.woff2` | JetBrains Mono（可変フォント、ウェイト 100〜800）の **Latin サブセット** |
| `OFL.txt` | SIL Open Font License 1.1。JetBrains Mono の配布に必要 |
| `dela-gothic-one-title.woff2` | Dela Gothic One の **題字サブセット**（2.2KB）。タイトルの canvas だけで使う |
| `OFL-dela-gothic-one.txt` | SIL Open Font License 1.1。Dela Gothic One の配布に必要 |

## 使い方

宣言は `src/ui/theme.css` の `@font-face` に1箇所だけある。`--mon-font` がそれを指す。

```css
@font-face {
  font-family: "JetBrains Mono";
  src: url("../../assets/fonts/jetbrains-mono-latin.woff2") format("woff2");
  font-weight: 100 800;
  unicode-range: U+0000-00FF, ...;   /* ラテンと数字と記号だけ */
}
```

`unicode-range` をラテンに限ってあるので、**日本語はこのフォントに一切かからない。**
同じ要素に混在していても、かなと漢字は `--jp-font`（ゴシック）へ自動的に落ちる。
数字だけを等幅で揃えたい箇所に `--mon-font` を当てられるのはこのため。

## 題字（Dela Gothic One）

太くて角のある見出し用。**入っているのは使う字だけ**（「ハルカのセッティングノート」と「夜中」の
15字）。ほかの字はこのフォントに当たらず、既定のゴシックへ落ちる。単一ウェイトなので
**太らせない（weight 400）**。合成ボールドをかけると角が潰れる。

宣言は `theme.css` の `@font-face` と `--title-font`。使うのは `src/ui/title.js` だけ。
canvas からは webfont の読み込みが始まらないので、`document.fonts.load()` を呼んでから描き直している。

字を足すときは、Google Fonts の CSS API に `text=` を付けて取り直す：

```
https://fonts.googleapis.com/css2?family=Dela+Gothic+One&text=<使う字>
```

## 出どころ

どちらも Google Fonts が配信しているサブセット（`fonts.gstatic.com`）をそのまま保存したもの。
JetBrains Mono は latin サブセット、Dela Gothic One は `text=` で作らせた題字サブセット。
サブセット化は Google 側で済んでいるので、こちらでツールは使っていない。

差し替えるときは、同じく latin サブセットの woff2 を取得してファイルを置き換え、
`OFL.txt` も一緒に更新する。ライセンス表示を外さないこと。
