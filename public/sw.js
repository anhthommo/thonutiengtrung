// Service worker: cho phép cài trang như ứng dụng và mở được khi mất mạng.
const VERSION = "v4";
const SHELL = ["/", "/pinyin-pro.js", "/hanzi-writer.min.js", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open("shell-" + VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("shell-") && k !== "shell-" + VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Âm thanh đã nghe, từ điển và dữ liệu nét chữ: lấy trong bộ nhớ trước, nghe lại không cần mạng
  if (url.pathname === "/api/tts" || url.pathname.startsWith("/dict/") || url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(caches.open("media").then(async c => {
      const hit = await c.match(req, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  // Các API khác (câu, cài đặt): luôn lấy mới
  if (url.pathname.startsWith("/api/")) return;

  // Trang và file tĩnh: lấy mới khi có mạng, mất mạng thì dùng bản đã lưu
  if (url.origin === location.origin) {
    // File phông chữ không đổi: lấy trong bộ nhớ trước cho nhanh
    if (url.pathname.startsWith("/fonts/")) {
      e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open("shell-" + VERSION).then(c => c.put(req, copy)); } return res; })));
      return;
    }
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open("shell-" + VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === "navigate" ? caches.match("/") : Response.error()))));
  }
});
