# assets/fonts

数字・ラテン・記号のための等幅フォント。**同梱して `@font-face` でローカル参照する。**
CDN からの読み込みは禁止（PLiCy 公開の制約。`CLAUDE.md`）。

| ファイル | 中身 |
|---|---|
| `jetbrains-mono-latin.woff2` | JetBrains Mono（可変フォント、ウェイト 100〜800）の **Latin サブセット** |
| `OFL.txt` | SIL Open Font License 1.1。JetBrains Mono の配布に必要 |

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

## 出どころ

Google Fonts が配信している JetBrains Mono v24 の latin サブセット（`fonts.gstatic.com`）を
そのまま保存したもの。サブセット化は Google 側で済んでいるので、こちらでツールは使っていない。

差し替えるときは、同じく latin サブセットの woff2 を取得してファイルを置き換え、
`OFL.txt` も一緒に更新する。ライセンス表示を外さないこと。
