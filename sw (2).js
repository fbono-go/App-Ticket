// Area 51 — Service Worker v2 (notificaciones por polling)
const DB_NAME = 'area51';
const DB_VERSION = 1;
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutos
const NOTIF_COOLDOWN = 60 * 60 * 1000; // 1 hora anti-spam

// ── IndexedDB ───────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function dbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => res(req.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function dbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    const req = tx.objectStore('kv').put(val, key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// ── Helpers ─────────────────────────────────────────────
function dentroDeHorario(cfg) {
  const ahora = new Date();
  const dia = ahora.getDay(); // 0=Dom, 1=Lun...6=Sab
  const dias = cfg.dias || [1,2,3,4,5];
  if (!dias.includes(dia)) return false;

  const [hIni, mIni] = (cfg.hora_ini || '08:00').split(':').map(Number);
  const [hFin, mFin] = (cfg.hora_fin || '20:00').split(':').map(Number);
  const minActual = ahora.getHours() * 60 + ahora.getMinutes();
  const minIni    = hIni * 60 + mIni;
  const minFin    = hFin * 60 + mFin;
  return minActual >= minIni && minActual <= minFin;
}

async function yaNotificado(key) {
  const ts = await dbGet('notif_' + key);
  if (!ts) return false;
  return (Date.now() - ts) < NOTIF_COOLDOWN;
}
async function marcarNotificado(key) {
  await dbSet('notif_' + key, Date.now());
}

function mostrarNotif(titulo, cuerpo, tag) {
  return self.registration.showNotification(titulo, {
    body:    cuerpo,
    tag:     tag,        // misma tag = reemplaza la anterior del mismo ticket
    icon:    '/App-Ticket/icons/icon-192x192.png',
    badge:   '/App-Ticket/icons/icon-192x192.png',
    vibrate: [200, 100, 200],
    data:    { url: '/App-Ticket/' }
  });
}

// ── Polling principal ───────────────────────────────────
async function poll() {
  try {
    // Leer config
    const cfg = await dbGet('notif_config');
    if (!cfg || !cfg.enabled) return;
    if (!dentroDeHorario(cfg)) return;

    const appCfg = await dbGet('app_config');
    if (!appCfg || !appCfg.sector_id) return;

    // Fetch tickets del sector
    const url = `${appCfg.proxy}/api/dashboard?sector_id=${appCfg.sector_id}`;
    const r = await fetch(url);
    if (!r.ok) return;
    const data = await r.json();
    const tickets = data.tickets || [];

    // Snapshot anterior
    const snap = (await dbGet('snapshot')) || { ids: [], vencidos: [] };
    const idsAnteriores = new Set(snap.ids || []);
    const vencidosAnteriores = new Set(snap.vencidos || []);
    const ahora = Date.now();
    const en24hs = ahora + 24 * 60 * 60 * 1000;

    const idsActuales = [];
    const vencidosActuales = [];

    for (const t of tickets) {
      idsActuales.push(t.id);

      // ── Ticket nuevo ──────────────────────────────────
      if (cfg.nuevo && !idsAnteriores.has(t.id)) {
        const key = `nuevo_${t.id}`;
        if (!(await yaNotificado(key))) {
          await mostrarNotif(
            '🎫 Ticket nuevo — Sector ' + (appCfg.sector_letra || ''),
            `#${t.number || t.id} · ${t.title || 'Sin título'}`,
            key
          );
          await marcarNotificado(key);
        }
      }

      // ── Ticket vencido ────────────────────────────────
      if (cfg.vencido && t.escalation_at) {
        const esc = new Date(t.escalation_at).getTime();
        const esVencido = esc < ahora;
        if (esVencido) {
          vencidosActuales.push(t.id);
          if (!vencidosAnteriores.has(t.id)) {
            const key = `vencido_${t.id}`;
            if (!(await yaNotificado(key))) {
              await mostrarNotif(
                '⏰ Ticket vencido',
                `#${t.number || t.id} · ${t.title || 'Sin título'}`,
                key
              );
              await marcarNotificado(key);
            }
          }
        }
      }

      // ── Por vencer en 24hs ────────────────────────────
      if (cfg.por_vencer && t.escalation_at) {
        const esc = new Date(t.escalation_at).getTime();
        if (esc > ahora && esc <= en24hs) {
          const key = `porvencer_${t.id}`;
          if (!(await yaNotificado(key))) {
            const hs = Math.round((esc - ahora) / 3600000);
            await mostrarNotif(
              '⚠️ Ticket por vencer',
              `#${t.number || t.id} vence en ~${hs}hs · ${t.title || ''}`,
              key
            );
            await marcarNotificado(key);
          }
        }
      }
    }

    // Guardar snapshot actualizado
    await dbSet('snapshot', {
      ids:      idsActuales,
      vencidos: vencidosActuales,
      ts:       ahora
    });

  } catch (e) {
    console.error('[SW] poll error:', e);
  }
}

// ── Ciclo de polling ────────────────────────────────────
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  poll(); // ejecutar inmediatamente
  pollTimer = setInterval(poll, POLL_INTERVAL);
}

// ── Eventos del SW ──────────────────────────────────────
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
  startPolling();
});

// Recibir mensajes desde la app (sincronizar config, forzar poll)
self.addEventListener('message', async event => {
  const { type, payload } = event.data || {};

  if (type === 'SYNC_CONFIG') {
    // La app guardó nueva config → sincronizar en IndexedDB del SW
    if (payload.notif_config) await dbSet('notif_config', payload.notif_config);
    if (payload.app_config)   await dbSet('app_config',   payload.app_config);
    startPolling();
  }

  if (type === 'FORCE_POLL') {
    await poll();
  }
});

// Clic en notificación → abrir/enfocar la app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const appUrl = event.notification.data?.url || '/App-Ticket/';
      const existing = clients.find(c => c.url.includes('/App-Ticket/'));
      if (existing) return existing.focus();
      return self.clients.openWindow(appUrl);
    })
  );
});
