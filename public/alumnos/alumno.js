import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { CONFIG, DOMINIO } from '../config.js';

const app = initializeApp(CONFIG), auth = getAuth(app), db = getFirestore(app);
const $ = id => document.getElementById(id), main = $('main');
const LOGIN_HTML = main.innerHTML;

// <helpers>
// Umbrales de color (una cifra decimal): 5.9 o menos = rojo, 7.9 o menos = amarillo.
const TOPE_ROJO = 5.9, TOPE_AMARILLO = 7.9;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normEmail = v => String(v || '').trim().toLowerCase();
const normTxt = v => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
const sortText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'es', { numeric: true, sensitivity: 'base' });

const nivel = n => { const r = Math.round(Number(n) * 10) / 10; return r <= TOPE_ROJO ? 'rojo' : r <= TOPE_AMARILLO ? 'amarillo' : 'ok'; };
const fmtNota = n => (Math.round(Number(n) * 10) / 10).toFixed(1);

const SMALL = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'a', 'al', 'o', 'u', 'con', 'para', 'por', 'un', 'una']);
const ROMAN = /^(i{1,3}|iv|v|vi{1,3}|ix|x)$/i;
function titleCase(s, { roman = true } = {}) {
  const str = String(s ?? '').trim(); if (!str) return '';
  if (str !== str.toUpperCase() && str !== str.toLowerCase()) return str; // ya trae formato mixto
  let first = true;
  return str.toLowerCase().split(/(\s+|-)/).map(w => {
    if (!w || /^\s+$|^-$/.test(w)) return w;
    const isFirst = first; first = false;
    if (roman && ROMAN.test(w)) return w.toUpperCase();
    if (!isFirst && SMALL.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}
const iniciales = n => String(n || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?';

const MESES = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, set: 8, oct: 9, nov: 10, dic: 11, jan: 0, apr: 3, aug: 7, dec: 11 };
function parseFecha(txt) {
  const s = String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) { let y = +m[3]; if (y < 100) y += 2000; return Date.UTC(y, +m[2] - 1, +m[1]); }
  const mes = (s.match(/[a-z]{3,}/g) || []).map(w => MESES[w.slice(0, 3)]).find(v => v !== undefined);
  const dia = s.match(/\b(\d{1,2})\b/), anio = s.match(/\b(20\d{2})\b/);
  if (mes !== undefined && dia) {
    let y = anio ? +anio[1] : new Date().getFullYear();
    if (!anio && Date.UTC(y, mes, +dia[1]) > Date.now() + 60 * 864e5) y--; // sin año: asume el más reciente
    return Date.UTC(y, mes, +dia[1]);
  }
  return null;
}
const fmtFecha = (txt, ts) => ts != null
  ? new Date(ts).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('.', '')
  : titleCase(txt, { roman: false });

const gmail = (to, asunto, cuerpo, cuenta) =>
  `https://mail.google.com/mail/?view=cm&fs=1&authuser=${encodeURIComponent(cuenta)}&to=${encodeURIComponent(to)}&su=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
// </helpers>

let estado = null; // { user, email, perfil, materias, filtro, abiertas }
let avisoLogin = '';

/* ============================== ACCESO ============================== */
main.addEventListener('click', e => {
  if (e.target.closest('#in')) return iniciarSesion();
  const head = e.target.closest('.mat-head');
  if (head) return alternar(head);
  const chip = e.target.closest('[data-f]');
  if (chip && estado) { estado.filtro = chip.dataset.f; pintarControles(); pintarLista(); }
});
$('out').onclick = () => signOut(auth);

// Si una foto de Google no carga, se sustituye por las iniciales.
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('av')) return;
  const ph = document.createElement('span');
  ph.className = img.className + ' ph'; ph.textContent = img.dataset.ini || '?';
  img.replaceWith(ph);
}, true);

function iniciarSesion() {
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ hd: DOMINIO, prompt: 'select_account' });
  signInWithPopup(auth, p).catch(e => {
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    mostrarErrorLogin(e.message);
  });
}
function mostrarErrorLogin(m) { const el = $('err'); if (el) { el.textContent = m; el.hidden = false; } }
function pintarLogin() {
  main.innerHTML = LOGIN_HTML; estado = null;
  if (avisoLogin) { mostrarErrorLogin(avisoLogin); avisoLogin = ''; }
}

onAuthStateChanged(auth, async u => {
  $('out').hidden = !u;
  if (!u) return pintarLogin();
  const email = normEmail(u.email);
  if (!email.endsWith('@' + DOMINIO) || u.emailVerified === false) {
    avisoLogin = `Solo puedes entrar con tu correo institucional @${DOMINIO}.`;
    return signOut(auth);
  }
  main.innerHTML = '<div class="al-card al-loading"><div class="spin" aria-hidden="true"></div><p>Cargando tus calificaciones…</p></div>';
  try {
    await u.getIdToken(true);
    estado = await cargar(u, email);
    pintar();
  } catch (e) {
    console.error('Panel alumno', e);
    main.innerHTML = `<div class="al-card al-error"><h3>No se pudo cargar tu información</h3>
      <p>${esc(e.code || '')} ${esc(e.message || '')}</p>
      <button id="reintentar" class="p" type="button">Reintentar</button></div>`;
    $('reintentar').onclick = () => location.reload();
  }
});

/* ============================== DATOS ============================== */
async function cargar(u, email) {
  const [alSnap, calSnap] = await Promise.all([
    getDoc(doc(db, 'alumnos', email)).catch(() => null),
    getDocs(query(collection(db, 'calificaciones'), where('correo', '==', email)))
  ]);
  const al = alSnap && alSnap.exists() ? alSnap.data() : {};
  const filas = calSnap.docs.map(d => d.data()).filter(r => r.asignatura || r.materia);

  const nombre = titleCase(al.nombre || filas.find(r => r.alumno)?.alumno || u.displayName || email.split('@')[0], { roman: false });
  const perfil = {
    nombre, email, foto: u.photoURL || '',
    matricula: String(al.matricula || '').trim(),
    grupoEs: String(al.grupoEspanol || '').trim(),
    grupoEn: String(al.grupoIngles || '').trim(),
    tutor: titleCase(al.tutor || '', { roman: false })
  };

  // Docentes (nombre y foto) — un solo documento por docente.
  const correosDoc = [...new Set(filas.map(r => normEmail(r.docente)).filter(Boolean))];
  const docentes = {};
  await Promise.all(correosDoc.map(async c => {
    try { const s = await getDoc(doc(db, 'docentes', c)); if (s.exists()) docentes[c] = s.data(); } catch (_) { /* se usa el nombre de la calificación */ }
  }));

  // Un cajón por MATERIA + GRUPO + DOCENTE.
  const mapa = new Map();
  for (const r of filas) {
    const materia = String(r.asignatura || r.materia).trim(), grupo = String(r.grupo || '').trim(), dc = normEmail(r.docente);
    const key = [normTxt(materia), normTxt(grupo), dc].join('|');
    if (!mapa.has(key)) mapa.set(key, { key, materia, grupo, docente: dc, profesor: r.profesor, filas: [] });
    const n = Number(r.calif);
    const ts = parseFecha(r.fecha);
    mapa.get(key).filas.push({ actividad: r.actividad, fecha: r.fecha, ts, calif: Number.isFinite(n) ? n : 0 });
  }

  const gEs = normTxt(perfil.grupoEs), gEn = normTxt(perfil.grupoEn);
  const materias = [...mapa.values()].map(m => {
    const info = docentes[m.docente] || {};
    m.nombre = titleCase(m.materia);
    m.tipo = normTxt(m.grupo) && normTxt(m.grupo) === gEs ? 'ES' : normTxt(m.grupo) && normTxt(m.grupo) === gEn ? 'EN' : '';
    m.docNombre = titleCase(info.nombre || m.profesor || m.docente || 'Docente', { roman: false });
    m.docFoto = info.foto || '';
    m.filas.sort((a, b) => (a.ts != null && b.ts != null) ? (b.ts - a.ts) : sortText(a.actividad, b.actividad));
    m.prom = m.filas.reduce((s, f) => s + f.calif, 0) / m.filas.length;
    m.rojas = m.filas.filter(f => nivel(f.calif) === 'rojo').length;
    m.amarillas = m.filas.filter(f => nivel(f.calif) === 'amarillo').length;
    return m;
  }).sort((a, b) => sortText(a.nombre, b.nombre));
  materias.forEach((m, i) => { m.id = 'mat-' + i; });

  return { user: u, email, perfil, materias, filtro: 'todas', abiertas: new Set() };
}

/* ============================== VISTA ============================== */
const avatar = (foto, nombre, clase) => foto
  ? `<img class="av ${clase}" src="${esc(foto)}" alt="" referrerpolicy="no-referrer" data-ini="${esc(iniciales(nombre))}">`
  : `<span class="av ${clase} ph">${esc(iniciales(nombre))}</span>`;

function pintar() {
  const { perfil, materias } = estado;
  const proms = materias.map(m => m.prom);
  const general = proms.length ? proms.reduce((a, b) => a + b, 0) / proms.length : null;
  const rojas = materias.reduce((s, m) => s + m.rojas, 0), amarillas = materias.reduce((s, m) => s + m.amarillas, 0);

  const dato = (et, v) => v ? `<div class="al-dato"><small>${et}</small><b>${esc(v)}</b></div>` : '';
  main.innerHTML = `
    <section class="al-perfil">
      ${avatar(perfil.foto, perfil.nombre, 'av-xl')}
      <div class="al-perfil-info">
        <span class="eyebrow">ALUMNO</span>
        <h2>${esc(perfil.nombre)}</h2>
        <p>${esc(perfil.email)}</p>
      </div>
      <div class="al-datos">
        ${dato('Matrícula', perfil.matricula)}
        ${dato('Grupo español', perfil.grupoEs || 'Sin registrar')}
        ${dato('Grupo inglés', perfil.grupoEn || 'Sin registrar')}
        ${dato('Tutor', perfil.tutor)}
      </div>
    </section>

    <div class="cards al-stats">
      <div><b>${materias.length}</b><span>Materias</span></div>
      <div><b class="${general == null ? '' : 'n-' + nivel(general)}">${general == null ? '—' : fmtNota(general)}</b><span>Promedio general</span></div>
      <div><b class="n-amarillo">${amarillas}</b><span>Actividades por mejorar</span></div>
      <div><b class="n-rojo">${rojas}</b><span>Atención prioritaria</span></div>
    </div>

    ${materias.length ? `
      <div class="al-controles" id="controles"></div>
      <div id="lista"></div>` : `
      <div class="al-card al-vacio">
        <h3>Aún no hay calificaciones registradas</h3>
        <p>No encontramos calificaciones ligadas a <strong>${esc(perfil.email)}</strong>. Aparecerán aquí en cuanto tus docentes carguen sus reportes.</p>
      </div>`}`;
  if (materias.length) { pintarControles(); pintarLista(); }
}

function pintarControles() {
  const { materias, filtro } = estado;
  const hay = t => materias.some(m => m.tipo === t);
  const chips = [['todas', 'Todas']];
  if (hay('ES')) chips.push(['ES', 'Español']);
  if (hay('EN')) chips.push(['EN', 'Inglés']);
  if (materias.some(m => m.rojas || m.amarillas)) chips.push(['alerta', 'Áreas de oportunidad']);
  $('controles').innerHTML = `
    <div class="al-chips" role="group" aria-label="Filtrar materias">
      ${chips.map(([k, n]) => `<button type="button" class="al-chip ${filtro === k ? 'on' : ''}" data-f="${k}" aria-pressed="${filtro === k}">${n}</button>`).join('')}
    </div>
    <div class="al-leyenda" aria-label="Significado de los colores">
      <span><i class="dot d-amarillo"></i>6.0 a 7.9 · Por mejorar</span>
      <span><i class="dot d-rojo"></i>5.9 o menos · Atención prioritaria</span>
    </div>`;
}

function pintarLista() {
  const { materias, filtro } = estado;
  const visibles = materias.filter(m => filtro === 'todas' || (filtro === 'alerta' ? (m.rojas || m.amarillas) : m.tipo === filtro));
  if (!visibles.length) { $('lista').innerHTML = '<div class="al-card al-vacio"><p>No hay materias para este filtro.</p></div>'; return; }
  const secciones = [['ES', 'Español'], ['EN', 'Inglés'], ['', 'Otras materias']];
  $('lista').innerHTML = secciones.map(([t, titulo]) => {
    const ms = visibles.filter(m => m.tipo === t); if (!ms.length) return '';
    const mostrarTitulo = visibles.some(m => m.tipo !== t) || t === '';
    return `<section class="al-seccion">${mostrarTitulo ? `<h3 class="al-sec-titulo">${titulo}</h3>` : ''}${ms.map(tarjeta).join('')}</section>`;
  }).join('');
}

function tarjeta(m) {
  const abierta = estado.abiertas.has(m.key), id = m.id;
  const nv = nivel(m.prom);
  return `
  <article class="mat n-borde-${nv}" data-k="${esc(m.key)}">
    <button type="button" class="mat-head" aria-expanded="${abierta}" aria-controls="${id}">
      <span class="mat-ico">${m.tipo || '•'}</span>
      <span class="mat-info">
        <strong>${esc(m.nombre)}</strong>
        <small>${esc(m.grupo ? m.grupo + ' · ' : '')}${esc(m.docNombre)}</small>
      </span>
      <span class="mat-flags">
        ${m.rojas ? `<span class="flag f-rojo" title="${m.rojas} actividad(es) en atención prioritaria">${m.rojas}</span>` : ''}
        ${m.amarillas ? `<span class="flag f-amarillo" title="${m.amarillas} actividad(es) por mejorar">${m.amarillas}</span>` : ''}
      </span>
      <span class="mat-prom" title="Promedio de la materia"><small>Promedio</small><b class="pill p-${nv}">${fmtNota(m.prom)}</b></span>
      <span class="chev" aria-hidden="true">▾</span>
    </button>
    <div class="mat-body" id="${id}" ${abierta ? '' : 'hidden'}>${cuerpo(m)}</div>
  </article>`;
}

function saludo(m) { return `Estimado(a) profesor(a) ${m.docNombre}:\n\n`; }
function firma() {
  const p = estado.perfil;
  return `Soy ${p.nombre}${p.matricula ? ', matrícula ' + p.matricula : ''}${p.grupoEs || p.grupoEn ? ' (' + [p.grupoEs && 'grupo español ' + p.grupoEs, p.grupoEn && 'grupo inglés ' + p.grupoEn].filter(Boolean).join(', ') + ')' : ''}.`;
}
function linkMateria(m) {
  const marcadas = m.filas.filter(f => nivel(f.calif) !== 'ok').slice(0, 12);
  const lista = marcadas.length
    ? '\n\nActividades que me gustaría revisar:\n' + marcadas.map(f => `• ${titleCase(f.actividad, { roman: false }) || 'Actividad'} (${fmtFecha(f.fecha, f.ts) || 's/f'}): ${fmtNota(f.calif)}`).join('\n')
    : '';
  const cuerpo = `${saludo(m)}${firma()} Le escribo para solicitar una aclaración sobre mis calificaciones de la materia ${m.nombre}.${lista}\n\nQuedo atento(a) a su respuesta. Muchas gracias.\n`;
  return gmail(m.docente, `Solicitud de aclaración · ${m.nombre}`, cuerpo, estado.email);
}
function linkActividad(m, f) {
  const cuerpo = `${saludo(m)}${firma()} Le escribo para solicitar una aclaración sobre una calificación de la materia ${m.nombre}:\n\n• Actividad: ${titleCase(f.actividad, { roman: false }) || 'Sin nombre'}\n• Fecha: ${fmtFecha(f.fecha, f.ts) || 'Sin fecha'}\n• Calificación registrada: ${fmtNota(f.calif)}\n\nQuedo atento(a) a su respuesta. Muchas gracias.\n`;
  return gmail(m.docente, `Aclaración de calificación · ${m.nombre}`, cuerpo, estado.email);
}

function cuerpo(m) {
  const filas = m.filas.map(f => {
    const nv = nivel(f.calif);
    return `<li class="act n-fila-${nv}">
      <span class="act-nombre">${esc(titleCase(f.actividad, { roman: false }) || 'Actividad sin nombre')}</span>
      <span class="act-fecha">${esc(fmtFecha(f.fecha, f.ts) || 'Sin fecha')}</span>
      <b class="pill p-${nv}">${fmtNota(f.calif)}</b>
      ${m.docente && nv !== 'ok' ? `<a class="act-aclarar" href="${esc(linkActividad(m, f))}" target="_blank" rel="noopener">Aclarar</a>` : '<span></span>'}
    </li>`;
  }).join('');
  return `
    <div class="doc-card">
      ${avatar(m.docFoto, m.docNombre, 'av-lg')}
      <div class="doc-info">
        <small>Docente</small>
        <strong>${esc(m.docNombre)}</strong>
        <span>${esc(m.docente)}</span>
      </div>
      ${m.docente ? `<a class="btn-aclaracion" href="${esc(linkMateria(m))}" target="_blank" rel="noopener">✉ Solicitar aclaración</a>` : ''}
    </div>
    <div class="act-cab"><span>Actividad</span><span>Fecha</span><span>Calificación</span><span></span></div>
    <ul class="act-lista">${filas}</ul>`;
}

function alternar(head) {
  const art = head.closest('.mat'), body = art.querySelector('.mat-body'), abrir = body.hidden;
  body.hidden = !abrir; head.setAttribute('aria-expanded', String(abrir));
  abrir ? estado.abiertas.add(art.dataset.k) : estado.abiertas.delete(art.dataset.k);
}
