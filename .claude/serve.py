"""開発用の静的サーバ。**配布物ではない**（.claude/ は PLiCy に上げない）。

`python -m http.server` と同じだが、**キャッシュを止める**。
このリポジトリは素の HTML+JS でビルドが無いので、直したファイルがブラウザの
キャッシュに残ると「直したはずが直っていない」に見える。それを潰すためだけのもの。

    python .claude/serve.py [port]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # 条件付き GET に 304 を返させない（no-store と合わせて、必ず中身を送る）
    def send_head(self):
        for name in ("If-Modified-Since", "If-None-Match"):
            del self.headers[name]   # email.message。無い名前を消しても落ちない
        return super().send_head()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    # 1リクエストで詰まると次が待たされるので、スレッドで受ける
    with ThreadingHTTPServer(("127.0.0.1", port), partial(Handler)) as httpd:
        print(f"serving on http://127.0.0.1:{port} (no-store)")
        httpd.serve_forever()
