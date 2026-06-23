// ============================================================
// TrafoTrack Service Worker
// Cache-first untuk assets statis, network-first untuk API
// ============================================================

const CACHE_NAME = 'trafotrack-v1';
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyEcIgOpDiOTzsgE3zmFQ-iA_V7B4xi9KoXZVbhc00wwTyyq5xIiAbNJA1UqsCRwQYg_g/exec';

// Aset yang di-cache saat install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.2/css/bootstrap.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.2/js/bootstrap.bundle.min.js',
];

// ── Install: precache assets ──────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        PRECACHE_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('Failed to cache:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: hapus cache lama ────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch strategy ────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls (GAS) → Network first, fallback ke offline response
  if (request.url.includes('script.google.com')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ ok: false, error: 'Offline — tidak ada koneksi internet.' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // CDN assets (Bootstrap, BI icons) → Cache first
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(request, clone));
        return res;
      }))
    );
    return;
  }

  // App shell (HTML, manifest, icons) → Cache first, revalidate
  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// ── Background sync: queue offline mutations ──────────────────
const SYNC_QUEUE_KEY = 'trafotrack-sync-queue';

self.addEventListener('sync', event => {
  if (event.tag === 'trafotrack-sync') {
    event.waitUntil(flushQueue());
  }
});

async function flushQueue() {
  const clients = await self.clients.matchAll();
  // Notify clients bahwa sync dimulai
  clients.forEach(c => c.postMessage({ type: 'SYNC_START' }));
  try {
    const cache = await caches.open(CACHE_NAME);
    const queueResp = await cache.match('/__sync_queue__');
    if (!queueResp) return;
    const queue = await queueResp.json();
    const failed = [];
    for (const item of queue) {
      try {
        const res = await fetch(GAS_URL, {
          method: 'POST',
          body: JSON.stringify(item),
        });
        const json = await res.json();
        if (!json.ok) failed.push(item);
      } catch {
        failed.push(item);
      }
    }
    // Simpan ulang yang gagal
    if (failed.length) {
      await cache.put('/__sync_queue__', new Response(JSON.stringify(failed)));
    } else {
      await cache.delete('/__sync_queue__');
    }
    clients.forEach(c => c.postMessage({
      type: 'SYNC_DONE',
      synced: queue.length - failed.length,
      failed: failed.length,
    }));
  } catch (e) {
    console.error('Sync failed:', e);
  }
}

// ── Push notification (opsional, untuk notif revisi/modifikasi) ──
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'TrafoTrack', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'trafotrack',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow(event.notification.data.url)
  );
});
