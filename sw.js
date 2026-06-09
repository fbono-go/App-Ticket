// Area 51 — Service Worker v5 (notificaciones multicapa, sin tráfico duplicado)
// Cambiar este número en cada deploy fuerza la actualización automática
const SW_VERSION = '5.0';
const DB_NAME = 'area51';
const DB_VERSION = 1;
const POLL_INTERVAL = 5 * 60 * 1000;   // 5 min (mientras el SW viva)
const NOTIF_COOLDOWN = 60 * 60 * 1000; // 1 hora anti-spam
const PRUNE_AGE = 7 * 24 * 60 * 60 * 1000; // limpiar claves anti-spam de +7 días

// Mientras la app esté abierta y mandando datos (EVAL_TICKETS), el SW
// NO descarga nada por su cuenta → se elimina el tráfico duplicado.
// Si la app se cierra, esta "ventana" expira sola y el SW retoma.
let appActivaHasta = 0;

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
async function dbKeys() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').getAllKeys();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = e => rej(e.target.error);
  });
}
async function dbDelete(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    const req = tx.objectStore('kv').delete(key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// Limpieza: las claves anti-spam (notif_*) se acumulaban para siempre.
// Una vez por día se borran las de más de 7 días.
async function limpiarClavesViejas() {
  try {
    const last = (await dbGet('last_prune')) || 0;
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    const keys = await dbKeys();
    for (const k of keys) {
      if (typeof k === 'string' && k.startsWith('notif_')) {
        const ts = await dbGet(k);
        if (typeof ts === 'number' && (Date.now() - ts) > PRUNE_AGE) await dbDelete(k);
      }
    }
    await dbSet('last_prune', Date.now());
  } catch (e) { /* la limpieza nunca debe romper el poll */ }
}

// ── Helpers ─────────────────────────────────────────────
function dentroDeHorario(cfg) {
  const ahora = new Date();
  const dia = ahora.getDay();
  const dias = cfg.dias || [1,2,3,4,5];
  if (!dias.includes(dia)) return false;
  const [hIni, mIni] = (cfg.hora_ini || '08:00').split(':').map(Number);
  const [hFin, mFin] = (cfg.hora_fin || '20:00').split(':').map(Number);
  const minActual = ahora.getHours() * 60 + ahora.getMinutes();
  return minActual >= (hIni*60+mIni) && minActual <= (hFin*60+mFin);
}
async function yaNotificado(key) {
  const ts = await dbGet('notif_' + key);
  return ts ? (Date.now() - ts) < NOTIF_COOLDOWN : false;
}
async function marcarNotificado(key) { await dbSet('notif_' + key, Date.now()); }

function mostrarNotif(titulo, cuerpo, tag) {
  const base = self.registration.scope;
  return self.registration.showNotification(titulo, {
    body: cuerpo, tag: tag, renotify: true,
    icon: base + 'icons/icon-192x192.png',
    badge: base + 'icons/icon-192x192.png',
    vibrate: [200, 100, 200],
    data: { url: base }
  });
}

// ── Evaluación de tickets (separada del fetch) ──────────
// Recibe la lista de tickets (descargada por el SW o pasada por la app)
// y decide qué notificar comparando contra el snapshot anterior.
async function evaluarTickets(tickets, cfg, appCfg) {
  const snap = (await dbGet('snapshot')) || null;
  const primeraVez = !snap;
  const idsAnteriores = new Set(snap ? snap.ids : []);
  const vencidosAnteriores = new Set(snap ? snap.vencidos : []);
  const ahora = Date.now();
  const en24hs = ahora + 24*60*60*1000;

  const idsActuales = [];
  const vencidosActuales = [];
  let notificadas = 0;

  for (const t of tickets) {
    idsActuales.push(t.id);

    // En la PRIMERA corrida no notificamos nada (solo guardamos base)
    if (cfg.nuevo && !primeraVez && !idsAnteriores.has(t.id)) {
      const key = `nuevo_${t.id}`;
      if (!(await yaNotificado(key))) {
        await mostrarNotif('🎫 Ticket nuevo — Sector ' + (appCfg.sector_letra||''),
          `#${t.number||t.id} · ${t.title||'Sin título'}`, key);
        await marcarNotificado(key); notificadas++;
      }
    }

    if (t.escalation_at) {
      const esc = new Date(t.escalation_at).getTime();
      if (cfg.vencido && esc < ahora) {
        vencidosActuales.push(t.id);
        if (!primeraVez && !vencidosAnteriores.has(t.id)) {
          const key = `vencido_${t.id}`;
          if (!(await yaNotificado(key))) {
            await mostrarNotif('⏰ Ticket vencido',
              `#${t.number||t.id} · ${t.title||'Sin título'}`, key);
            await marcarNotificado(key); notificadas++;
          }
        }
      }
      if (cfg.por_vencer && esc > ahora && esc <= en24hs) {
        const key = `porvencer_${t.id}`;
        if (!(await yaNotificado(key))) {
          const hs = Math.round((esc - ahora)/3600000);
          await mostrarNotif('⚠️ Ticket por vencer',
            `#${t.number||t.id} vence en ~${hs}hs · ${t.title||''}`, key);
          await marcarNotificado(key); notificadas++;
        }
      }
    }
  }

  await dbSet('snapshot', { ids: idsActuales, vencidos: vencidosActuales, ts: ahora });
  await limpiarClavesViejas();
  return { ran:true, primeraVez, total: tickets.length, notificadas };
}

// ── Poll principal (descarga + evalúa) ──────────────────
async function poll(opts = {}) {
  try {
    const cfg = await dbGet('notif_config');
    if (!cfg || !cfg.enabled) return { ran:false, reason:'disabled' };
    if (!opts.ignoreHorario && !dentroDeHorario(cfg)) return { ran:false, reason:'fuera_horario' };

    // Si la app está abierta, ELLA manda los datos (EVAL_TICKETS):
    // el SW no descarga lo mismo de nuevo. FORCE_POLL ignora esto.
    if (!opts.force && Date.now() < appActivaHasta) return { ran:false, reason:'app_activa' };

    const appCfg = await dbGet('app_config');
    if (!appCfg || !appCfg.sector_id) return { ran:false, reason:'sin_config' };

    const url = `${appCfg.proxy}/api/dashboard?sector_id=${appCfg.sector_id}`;
    const r = await fetch(url, {
      cache: 'no-store',
      headers: { 'Authorization': 'Token token=' + (appCfg.token || '') }
    });
    if (!r.ok) return { ran:false, reason:'fetch_fail' };
    const data = await r.json();
    return await evaluarTickets(data.tickets || [], cfg, appCfg);
  } catch (e) {
    console.error('[SW] poll error:', e);
    return { ran:false, reason:'error', error:String(e) };
  }
}

// ── Ciclo de polling (mientras el SW viva) ──────────────
let pollTimer = null;
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL);
}

// ── Eventos del SW ──────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    startPolling();
  })());
});

// Periodic Background Sync (Android, PWA instalada)
self.addEventListener('periodicsync', event => {
  if (event.tag === 'area51-poll') {
    event.waitUntil(poll());
  }
});

// Background Sync puntual (fallback)
self.addEventListener('sync', event => {
  if (event.tag === 'area51-poll-once') {
    event.waitUntil(poll());
  }
});

// Mensajes desde la app
self.addEventListener('message', async event => {
  const { type, payload } = event.data || {};
  const reply = event.ports && event.ports[0];

  if (type === 'SYNC_CONFIG') {
    if (payload.notif_config) await dbSet('notif_config', payload.notif_config);
    if (payload.app_config)   await dbSet('app_config',   payload.app_config);
    startPolling();
    if (reply) reply.postMessage({ ok:true });
  }

  // La app manda los tickets que YA descargó → el SW evalúa
  // notificaciones sin volver a pedirle nada al servidor.
  if (type === 'EVAL_TICKETS') {
    appActivaHasta = Date.now() + 6 * 60 * 1000; // ventana renovable
    let res = { ran:false, reason:'disabled' };
    try {
      const cfg = await dbGet('notif_config');
      const appCfg = await dbGet('app_config');
      if (cfg && cfg.enabled && appCfg && dentroDeHorario(cfg)) {
        res = await evaluarTickets((payload && payload.tickets) || [], cfg, appCfg);
      }
    } catch(e){ res = { ran:false, reason:'error', error:String(e) }; }
    if (reply) reply.postMessage(res);
  }

  if (type === 'FORCE_POLL') {
    const res = await poll({ ignoreHorario: !!(payload && payload.ignoreHorario), force: true });
    if (reply) reply.postMessage(res);
  }

  if (type === 'TEST_NOTIF') {
    await mostrarNotif('✅ Notificación de prueba',
      'Las notificaciones de Area 51 funcionan correctamente', 'test_' + Date.now());
    if (reply) reply.postMessage({ ok:true });
  }

  if (type === 'RESET_SNAPSHOT') {
    await dbSet('snapshot', null);
    if (reply) reply.postMessage({ ok:true });
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      const appUrl = event.notification.data?.url || self.registration.scope;
      const existing = clients.find(c => c.url.startsWith(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(appUrl);
    })
  );
});
