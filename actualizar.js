/* GO Mantenimiento · actualización automática (UPD-v1)
   GitHub Pages le pone la misma fecha a todos los archivos en cada publicación.
   Si la del servidor es más nueva que la de la página abierta, hay versión
   nueva: no hay que cambiar ningún número de versión a mano. */
(function () {
  'use strict';

  var PAUSA_LARGA = 30 * 60 * 1000;   // fuera de la app este tiempo: se puede recargar sola
  var CADA = 15 * 60 * 1000;          // chequeo con la app abierta
  var INICIO = ['s-home', 's-espera', 's-prev', 's-bandeja'];
  var CLAVE = 'go-actualizado';       // evita recargar en bucle por la misma versión

  var cargada = Date.parse(document.lastModified);
  var toco = false, oculta = 0, ultimo = 0, ocupado = false;

  ['pointerdown', 'keydown'].forEach(function (ev) {
    addEventListener(ev, function () { toco = true; }, { capture: true, passive: true });
  });

  /** ¿Está en una pantalla de inicio, sin nada a medio cargar? */
  function libre() {
    var s = document.querySelector('.screen.active');
    if (!s || INICIO.indexOf(s.id) === -1) return false;
    if (s.id === 's-prev' && document.querySelector('.prev-pant.on:not(#prev-pant-inicio)')) return false;
    return !Array.prototype.some.call(document.querySelectorAll('#s-crear textarea'),
      function (t) { return t.value.trim(); });
  }

  /** Renueva en el caché la página y sus módulos (aunque no cambie el ?v=) y recarga. */
  function aplicar() {
    if (ocupado) return;
    ocupado = true;
    var urls = [location.href];
    Array.prototype.forEach.call(document.scripts, function (s) {
      if (s.src && s.src.indexOf(location.origin + '/') === 0) urls.push(s.src);
    });
    Promise.all(urls.map(function (u) {
      return fetch(u, { cache: 'reload' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      });
    })).then(function () { location.reload(); })
      .catch(function () { ocupado = false; });   // sin señal: se reintenta después
  }

  function avisar() {
    if (document.getElementById('go-upd')) return;
    var estilo = document.createElement('style');
    estilo.textContent = '#go-upd{position:fixed;left:12px;right:12px;' +
      'top:calc(env(safe-area-inset-top,0px) + 10px);max-width:460px;margin:auto;z-index:100000;' +
      'padding:13px 16px;border:0;border-radius:12px;background:#0060D6;color:#fff;' +
      'font:700 14px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}' +
      '@media print{#go-upd{display:none}}';
    var b = document.createElement('button');
    b.id = 'go-upd';
    b.type = 'button';
    b.textContent = 'Hay una versión nueva · Tocá para actualizar';
    b.onclick = aplicar;
    document.head.appendChild(estilo);
    document.body.appendChild(b);
  }

  /** puedeSola: el momento permite recargar sin preguntar. */
  function chequear(puedeSola) {
    if (!navigator.onLine || Date.now() - ultimo < 60000) return;
    ultimo = Date.now();
    fetch(location.pathname + '?_=' + ultimo, { method: 'HEAD', cache: 'no-store' })
      .then(function (r) {
        var nueva = r.ok ? Date.parse(r.headers.get('last-modified')) : NaN;
        if (!(nueva - cargada > 1000)) return;
        var intentada = null;
        try { intentada = sessionStorage.getItem(CLAVE); } catch (e) {}
        if (puedeSola() && intentada !== String(nueva)) {
          try { sessionStorage.setItem(CLAVE, String(nueva)); } catch (e) {}
          aplicar();
        } else {
          avisar();
        }
      })
      .catch(function () {});
  }

  var alAbrir = function () { return !toco; };

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { oculta = Date.now(); return; }
    var larga = oculta && Date.now() - oculta >= PAUSA_LARGA;
    chequear(function () { return larga && libre(); });
  });
  setInterval(function () {
    if (document.visibilityState === 'visible') chequear(function () { return false; });
  }, CADA);

  chequear(alAbrir);
})();
