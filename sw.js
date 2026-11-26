// オフラインでも最後に開いた内容を表示するための Service Worker（https で開いた時だけ登録される）
// アプリを更新したら VERSION を上げる
const VERSION = "shift-board-v1";
const ASSETS = ["./", "index.html", "style.css", "app.js", "vendor/qrcode.js", "manifest.webmanifest", "icons/icon.svg", "icons/apple-touch-icon.png", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// 同じ場所のファイルだけ：キャッシュを即返しつつ裏で最新を取得（同期の通信には触らない）
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
