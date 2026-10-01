/**
 * Programados.gs — almacenamiento de los tickets programados.
 *
 * Vive en SU PROPIA planilla y su propio Apps Script, separado del de
 * preventivo, para que lo nuevo no pueda romper lo que ya funciona.
 *
 * Instalación:
 *  1. Planilla nueva de Google ("Tickets programados").
 *  2. Extensiones > Apps Script > pegar este archivo completo (reemplaza todo).
 *  3. Configuración del proyecto (engranaje) > Propiedades del script >
 *     agregar  TOKEN = (un texto largo y secreto; el mismo va en Render como PROG_TOKEN).
 *  4. Implementar > Nueva implementación > Aplicación web
 *     Ejecutar como: Yo   |   Quién tiene acceso: Cualquier usuario.
 *     Copiar la URL que termina en /exec  (va en Render como PROG_SHEETS_URL).
 *  5. Si después se cambia este código: Implementar > Administrar implementaciones >
 *     lápiz > Versión nueva. Si no, Render sigue hablando con la versión vieja.
 *
 * La hoja "Programados" se crea sola. Se puede mirar y corregir a mano; las
 * columnas ultimaClave / ultimaEjecucion / ultimoError las completa el sistema.
 */

const HOJA = 'Programados';
const ZONA = 'America/Argentina/Buenos_Aires';
const COLUMNAS = ['id', 'nombre', 'activo', 'frecuencia', 'hora', 'diasSemana', 'diaMes',
  'ultimaClave', 'ultimaEjecucion', 'ultimoError', 'creado', 'ticket'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  let conLock = false;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || req.token !== token) return salida({ ok: false, error: 'No autorizado' });

    lock.waitLock(25000); // una sola escritura a la vez: la reserva es atómica
    conLock = true;
    const h = hoja();

    switch (req.accion) {
      case 'listar':
        return salida({ ok: true, items: leer(h).map(aObjeto) });

      case 'guardar': {
        const p = req.prog || {};
        const fila = p.id ? buscar(h, p.id) : 0;
        const id = p.id || Utilities.getUuid().slice(0, 8);
        const previo = fila ? valores(h, fila) : null;
        const nuevo = aFila({
          id: id,
          nombre: p.nombre,
          activo: p.activo !== false,
          frecuencia: p.frecuencia,
          hora: p.hora,
          diasSemana: p.diasSemana,
          diaMes: p.diaMes,
          ultimaClave: p.ultimaClave || '',
          ultimaEjecucion: previo ? previo.ultimaEjecucion : '',
          ultimoError: '',
          creado: previo ? previo.creado : ahora(),
          ticket: p.ticket,
        });
        escribir(h, fila || h.getLastRow() + 1, nuevo);
        return salida({ ok: true, prog: aObjeto(nuevo) });
      }

      case 'borrar': {
        const fila = buscar(h, req.id);
        if (fila) h.deleteRow(fila);
        return salida({ ok: true });
      }

      case 'activo': {
        const fila = buscar(h, req.id);
        if (!fila) return salida({ ok: false, error: 'No existe' });
        const v = valores(h, fila);
        v.activo = req.activo === true ? 'SI' : 'NO';
        if (req.ultimaClave !== undefined && req.ultimaClave !== null) v.ultimaClave = String(req.ultimaClave);
        v.ultimoError = '';
        escribir(h, fila, COLUMNAS.map(function (c) { return v[c]; }));
        return salida({ ok: true });
      }

      case 'marcar': {
        // Compare-and-set: solo gana quien encuentra el período sin marcar.
        const fila = buscar(h, req.id);
        if (!fila) return salida({ ok: false, error: 'No existe' });
        const v = valores(h, fila);
        if (v.ultimaClave === String(req.clave)) return salida({ ok: true, tomada: false });
        v.ultimaClave = String(req.clave);
        v.ultimaEjecucion = ahora();
        v.ultimoError = '';
        escribir(h, fila, COLUMNAS.map(function (c) { return v[c]; }));
        return salida({ ok: true, tomada: true });
      }

      case 'desmarcar': {
        // La creación falló: se libera el período y se deja el motivo a la vista.
        const fila = buscar(h, req.id);
        if (!fila) return salida({ ok: true });
        const v = valores(h, fila);
        v.ultimaClave = String(req.anterior || '');
        v.ultimoError = ahora() + ' · ' + String(req.error || 'error').slice(0, 250);
        escribir(h, fila, COLUMNAS.map(function (c) { return v[c]; }));
        return salida({ ok: true });
      }

      default:
        return salida({ ok: false, error: 'Acción desconocida' });
    }
  } catch (err) {
    return salida({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (conLock) lock.releaseLock();
  }
}

// ---------------------------------------------------------------- hoja

function hoja() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let h = ss.getSheetByName(HOJA);
  if (!h) {
    h = ss.insertSheet(HOJA);
    h.getRange(1, 1, 1, COLUMNAS.length).setValues([COLUMNAS]).setFontWeight('bold');
    h.setFrozenRows(1);
  }
  return h;
}

/** Filas de datos (sin encabezado), como texto tal cual se ve. */
function leer(h) {
  const n = h.getLastRow() - 1;
  if (n < 1) return [];
  return h.getRange(2, 1, n, COLUMNAS.length).getDisplayValues()
    .filter(function (f) { return f[0] !== ''; });
}

/** Número de fila (1-based) del id, o 0. */
function buscar(h, id) {
  const n = h.getLastRow() - 1;
  if (n < 1 || !id) return 0;
  const ids = h.getRange(2, 1, n, 1).getDisplayValues();
  for (let i = 0; i < n; i++) if (ids[i][0] === String(id)) return i + 2;
  return 0;
}

function valores(h, fila) {
  const f = h.getRange(fila, 1, 1, COLUMNAS.length).getDisplayValues()[0];
  const v = {};
  COLUMNAS.forEach(function (c, i) { v[c] = f[i]; });
  return v;
}

/**
 * Escribe como TEXTO PLANO: sin esto Sheets convierte "08:00" en hora y
 * "2026-10-01" en fecha, y el servidor leería otra cosa.
 */
function escribir(h, fila, arreglo) {
  const rango = h.getRange(fila, 1, 1, COLUMNAS.length);
  rango.setNumberFormat('@');
  rango.setValues([arreglo]);
}

// ---------------------------------------------------------------- conversión

function aFila(p) {
  return [
    String(p.id),
    String(p.nombre || ''),
    p.activo ? 'SI' : 'NO',
    String(p.frecuencia || ''),
    String(p.hora || ''),
    (p.diasSemana || []).join(','),
    p.diaMes ? String(p.diaMes) : '',
    String(p.ultimaClave || ''),
    String(p.ultimaEjecucion || ''),
    String(p.ultimoError || ''),
    String(p.creado || ''),
    JSON.stringify(p.ticket || {}),
  ];
}

function aObjeto(f) {
  const o = {};
  COLUMNAS.forEach(function (c, i) { o[c] = f[i]; });
  let ticket = {};
  try { ticket = JSON.parse(o.ticket || '{}'); } catch (err) { ticket = {}; }
  return {
    id: o.id,
    nombre: o.nombre,
    activo: o.activo === 'SI',
    frecuencia: o.frecuencia,
    hora: o.hora,
    diasSemana: o.diasSemana ? o.diasSemana.split(',').map(Number) : [],
    diaMes: o.diaMes ? Number(o.diaMes) : null,
    ultimaClave: o.ultimaClave,
    ultimaEjecucion: o.ultimaEjecucion,
    ultimoError: o.ultimoError,
    creado: o.creado,
    ticket: ticket,
  };
}

function ahora() {
  return Utilities.formatDate(new Date(), ZONA, 'yyyy-MM-dd HH:mm');
}

function salida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
