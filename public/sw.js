const CACHE = "textedit-v2";
const SHARE_CACHE = "textedit-share";
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"]))); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

async function handleShare(request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const hasFile = file && typeof file !== "string";
    const text = hasFile ? await file.text() : (formData.get("text") || formData.get("title") || "");
    const name = hasFile && file.name ? file.name : "Delad text.txt";
    const cache = await caches.open(SHARE_CACHE);
    await cache.put("/__shared-file", new Response(text, { headers: { "X-File-Name": name } }));
  } catch {
    // tyst fel – appen öppnas ändå, bara utan förifylld text
  }
  return Response.redirect("/?shared=1", 303);
}

self.addEventListener("fetch", (e) => {
  const r = e.request;
  const url = new URL(r.url);
  if (r.method === "POST" && url.pathname === "/share-target") {
    e.respondWith(handleShare(r));
    return;
  }
  if (r.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(r).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); return res; }).catch(() => caches.match(r).then((m) => m || caches.match("/"))));
});
