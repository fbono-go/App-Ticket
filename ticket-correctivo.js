/* ═══════════════════════════════════════════════════════════════════════
   GO Mantenimiento · Preventivo QR — crear el ticket de un correctivo
   ───────────────────────────────────────────────────────────────────────
   Un solo lugar para armar y crear el ticket. Lo usan la bandeja de
   index.html (bandeja-ui.js) y el Panel de control (panel-preventivo.html):
   si el ticket cambia, cambia en los dos.

   POR QUÉ ES ASÍ
   Los tickets no se crean por la API de Zammad: se crean entrando al portal
   de empleados con el email y la contraseña del referente. La app las guarda
   en este navegador (Config → area51_config), y las páginas del sitio las
   comparten porque son el mismo origen.

   USO
       TicketCorrectivo.confirmar(caso, marcar, progreso)
         caso      el correctivo tal como lo devuelve /bandeja
         marcar    función que registra "confirmado" y devuelve una promesa
         progreso  (opcional) función(texto) para mostrar en qué paso va
       Si falla, el error trae e.ticketCreado = true|false.

   INSTALACIÓN: cargarlo con un script src="./ticket-correctivo.js" antes
   del script que lo use.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  if (window.TicketCorrectivo) return;

  var BUILD = 'TC-v1';
  var AREA_MANTENIMIENTO = '1';
  var PROXY_DEFECTO = 'https://gored-proxy-ov5y.onrender.com';

  function credenciales() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem('area51_config') || '{}'); } catch (e) {}
    return {
      email: (c.mi_email || '').trim(),
      password: c.portal_pass || '',
      proxy: (c.proxy && c.proxy.indexOf('gored-proxy.onrender') === -1) ? c.proxy : PROXY_DEFECTO
    };
  }

  function fechaCorta(iso) {
    var s = String(iso || '');
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d)) return s.slice(0, 16).replace('T', ' ');
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) + ' ' +
           d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  /** Lo que espera /api/crear-portal. Lanza Error si al equipo le faltan datos. */
  function armar(caso, cred) {
    var t = caso.ticket || {};
    if (!t.institucion_id || !t.categoria_id) {
      throw new Error('al equipo le faltan datos (institución o categoría); revisalo en la planilla');
    }

    var descripcion =
      'Correctivo generado por el preventivo del ' + fechaCorta(caso.fecha_deteccion) + '.\n\n' +
      'Equipo: ' + caso.equipo_id + (caso.tipo_nombre ? ' (' + caso.tipo_nombre + ')' : '') + '\n' +
      (caso.ubicacion_detalle ? 'Ubicación exacta: ' + caso.ubicacion_detalle + '\n' : '') +
      'Ubicación: ' + (caso.referencia || '') + '\n' +
      'Lo detectó: ' + (caso.detectado_por || 'sin identificar') + '\n\n' +
      'Desvíos:\n' +
      (caso.desvios || []).map(function (d) {
        return '· ' + (d.etiqueta || d.campo) + ': ' + (d.regla || d.valor);
      }).join('\n') +
      (caso.afecta_ambientes
        ? '\n\nDe este equipo dependen ' + caso.afecta_ambientes + ' ambiente(s).' : '');

    return {
      email: cred.email,
      password: cred.password,
      facility: String(t.institucion_id),
      cost_center: String(t.lugar_id || ''),
      floor: String(t.piso_id || ''),
      // en el portal es "descripción del lugar": ahí va "Habitación 5", no el piso otra vez
      place_description: caso.ubicacion_detalle
        ? caso.ubicacion_detalle + ' · ' + caso.equipo_id
        : (caso.referencia || caso.equipo_id),
      responsible_area: AREA_MANTENIMIENTO,
      category: String(t.categoria_id),
      subcategory: t.subcategoria_id ? String(t.subcategoria_id) : '',
      // corto y siempre igual: el detalle del desvío va en la descripción
      title: 'Correctivo de ' + caso.equipo_id,
      description: descripcion,
      fotos: [],
    };
  }

  /** Crea el ticket en el portal. Rechaza con un mensaje legible si no se pudo. */
  function crear(caso) {
    var cred = credenciales();
    if (!cred.email || !cred.password) {
      return Promise.reject(new Error(
        'faltan tu email y contraseña del portal; cargalos en Config de la app, ' +
        'desde este mismo navegador'));
    }

    var datos;
    try { datos = armar(caso, cred); } catch (e) { return Promise.reject(e); }

    return fetch(cred.proxy + '/api/crear-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos),
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) {}
        if (!r.ok || !j || !j.ok) {
          throw new Error((j && j.error) || ('el portal respondió ' + r.status));
        }
      });
    });
  }

  /**
   * Crea el ticket y RECIÉN DESPUÉS ejecuta `marcar`.
   *
   * Ese orden importa: si se marcara primero y el portal fallara, el caso
   * desaparecería de la lista sin que exista el ticket, y nadie se enteraría.
   * Y si el ticket se creó pero `marcar` falla, el error lo dice
   * (ticketCreado = true): confirmar de nuevo duplicaría el ticket.
   */
  function confirmar(caso, marcar, progreso) {
    var avisar = typeof progreso === 'function' ? progreso : function () {};
    var creado = false;

    avisar('Creando el ticket en el portal…');
    return crear(caso).then(function () {
      creado = true;
      avisar('Ticket creado. Guardando la decisión…');
      return marcar();
    }).catch(function (e) {
      e.ticketCreado = creado;
      throw e;
    });
  }

  window.TicketCorrectivo = { BUILD: BUILD, confirmar: confirmar };
})();
