import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where, writeBatch, serverTimestamp, arrayUnion } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { CONFIG, BRIDGE_URL, ADMIN_EMAIL, DOMINIO } from './config.js';

const app = initializeApp(CONFIG), auth = getAuth(app), db = getFirestore(app);
const $ = id => document.getElementById(id), main = $('main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = s => { let a = 0xdeadbeef, b = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); } a = Math.imul(a ^ a >>> 16, 2246822507) ^ Math.imul(b ^ b >>> 13, 3266489909); b = Math.imul(b ^ b >>> 16, 2246822507) ^ Math.imul(a ^ a >>> 13, 3266489909); return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36); };
const normEmail = v => String(v || '').trim().toLowerCase();
let me = null;

const PRIVILEGES = {
  dashboardGeneral: 'Dashboard general',
  docentes: 'Panel de docentes',
  cargas: 'Cargas y registros',
  asignaciones: 'Asignaciones',
  avance: 'Avance general',
  grupos: 'Grupos',
  asignaturas: 'Asignaturas',
  alumnos: 'Alumnos'
};
const DIRECTIVO_DEFAULTS = Object.keys(PRIVILEGES);
const allPrivs = () => Object.keys(PRIVILEGES);
const hasPriv = p => me?.rol === 'admin' || (me?.rol === 'directivo' && Array.isArray(me?.permisos) && me.permisos.includes(p));
const canOpen = k => me?.rol === 'admin' || ({
  dashboard: hasPriv('dashboardGeneral'),
  docentes: hasPriv('docentes'),
  gruposES: hasPriv('grupos'),
  gruposEN: hasPriv('grupos'),
  asignaturas: hasPriv('asignaturas'),
  alumnos: hasPriv('alumnos'),
  asignaciones: hasPriv('asignaciones'),
  avance: hasPriv('avance'),
  importar: me?.rol === 'docente' || me?.rol === 'admin',
  misAsignaciones: me?.rol === 'docente',
  miAvance: me?.rol === 'docente'
}[k]);

const TABS = {
  docentes: { n: 'Docentes', col: 'docentes', f: ['correo', 'nombre', 'matricula', 'rol'], key: 'correo', def: { rol: 'docente' }, types: { rol: ['docente', 'directivo', 'admin'] } },
  gruposES: { n: 'Grupos español', col: 'grupos', f: ['nombre'], fix: { tipo: 'ESPAÑOL' }, w: ['tipo', '==', 'ESPAÑOL'], key: 'nombre' },
  gruposEN: { n: 'Grupos inglés', col: 'grupos', f: ['nombre'], fix: { tipo: 'INGLES' }, w: ['tipo', '==', 'INGLES'], key: 'nombre' },
  asignaturas: { n: 'Asignaturas', col: 'asignaturas', f: ['nombre', 'tipo'], key: 'nombre', types: { tipo: ['ESPAÑOL', 'INGLES'] } },
  alumnos: { n: 'Alumnos', col: 'alumnos', f: ['matricula', 'nombre', 'correo', 'grupoEspanol', 'grupoIngles', 'tutor'], key: 'correo' },
  asignaciones: { n: 'Asignaciones', col: 'asignaciones', f: ['docente', 'grupo', 'materia', 'tipo', 'url'], key: null },
  avance: { n: 'Avance', col: 'avance', f: ['docente', 'nombre', 'grupo', 'asignatura', 'filas', 'alumnos', 'url', 'estado'], key: null, def: { estado: 'CARGADO' } }
};

$('in').onclick = () => { const p = new GoogleAuthProvider(); p.setCustomParameters({ hd: DOMINIO, prompt: 'select_account' }); signInWithPopup(auth, p).catch(e => $('err').textContent = e.message); };
$('out').onclick = () => signOut(auth);

onAuthStateChanged(auth, async u => {
  $('out').hidden = !u; $('nav').innerHTML = '';
  if (!u) { me = null; return; }

  try {
    // Fuerza un token fresco antes de consultar reglas de Firestore y antes de
    // enviarlo al puente de Google Sheets. Esto evita trabajar con una sesión
    // antigua después de cambiar de cuenta.
    await u.getIdToken(true);
    const email = normEmail(u.email);
    if (!email.endsWith('@' + DOMINIO)) return bloqueo('Usa tu cuenta @' + DOMINIO);
    if (u.emailVerified === false) return bloqueo('Tu cuenta de Google debe estar verificada.');

    const admin = email === ADMIN_EMAIL.toLowerCase();
    const perfilRef = doc(db, 'docentes', email);
    let d = await getDoc(perfilRef);

    if (admin) {
      const perfil = {
        correo: email,
        nombre: u.displayName || 'Administrador IBIME',
        foto: u.photoURL || '',
        rol: 'admin',
        actualizado: serverTimestamp()
      };
      await setDoc(perfilRef, normalizarGuardado(perfil), { merge: true });
      me = { email, nombre: perfil.nombre, foto: perfil.foto, rol: 'admin' };
    } else {
      if (!d.exists()) {
        const perfil = {
          correo: email,
          nombre: u.displayName || email.split('@')[0],
          foto: u.photoURL || '',
          rol: 'docente',
          fechaAlta: serverTimestamp(),
          actualizado: serverTimestamp()
        };
        await setDoc(perfilRef, normalizarGuardado(perfil));
        d = await getDoc(perfilRef);
      }

      const data = d.data() || {};
      const rol = String(data.rol || '').trim().toLowerCase();
      if (!['docente', 'directivo', 'admin'].includes(rol)) {
        return bloqueo('Tu cuenta no tiene un rol de docente válido. Contacta al administrador.');
      }
      me = {
        email,
        nombre: data.nombre || u.displayName || email,
        foto: data.foto || u.photoURL || '',
        rol,
        permisos: Array.isArray(data.permisos) ? data.permisos : (rol === 'directivo' ? DIRECTIVO_DEFAULTS : [])
      };
      // Conserva/actualiza la foto pública de Google para identificar al docente/directivo.
      if (!data.foto && u.photoURL && (rol === 'docente' || rol === 'directivo')) {
        try { await setDoc(perfilRef, { foto: u.photoURL, actualizado: serverTimestamp() }, { merge: true }); } catch (_) {}
      }
    }

    menu();
    await ir('dashboard');
  } catch (e) {
    console.error('Error al inicializar sesión', e);
    bloqueo(`No se pudo iniciar tu sesión académica. ${e.code || ''} ${e.message || ''}`.trim());
  }
});

const bloqueo = m => { main.innerHTML = `<div id="login"><p class="msg">${esc(m)}</p></div>`; };
function menu() {
  let items;
  if (me.rol === 'admin') {
    items = [['dashboard', 'Dashboard'], ['importar', 'Cargar reportes'], ['cargasPanel', 'Cargas'], ['asignaciones', 'Asignaciones'], ['avance', 'Avance general'], ...Object.keys(TABS).filter(k => !['asignaciones','avance'].includes(k)).map(k => [k, TABS[k].n])];
  } else if (me.rol === 'directivo') {
    items = [['dashboard', 'Dashboard general']];
    if (hasPriv('docentes')) items.push(['docentes', 'Docentes']);
    if (hasPriv('cargas')) items.push(['cargasPanel', 'Cargas']);
    if (hasPriv('asignaciones')) items.push(['asignaciones', 'Asignaciones']);
    if (hasPriv('avance')) items.push(['avance', 'Avance general']);
    if (hasPriv('grupos')) items.push(['gruposES', 'Grupos español'], ['gruposEN', 'Grupos inglés']);
    if (hasPriv('asignaturas')) items.push(['asignaturas', 'Asignaturas']);
    if (hasPriv('alumnos')) items.push(['alumnos', 'Alumnos']);
  } else {
    items = [['dashboard', 'Dashboard'], ['importar', 'Cargar reportes'], ['misAsignaciones', 'Mis asignaciones'], ['miAvance', 'Mi avance']];
  }
  $('nav').innerHTML = items.map(([k, n]) => `<button data-k="${k}">${n}</button>`).join('');
  $('nav').onclick = e => e.target.dataset.k && ir(e.target.dataset.k);
}

function ir(k) {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  if (!canOpen(k) && k !== 'cargasPanel') {
    main.innerHTML = '<div class="empty"><h3>Sin privilegios</h3><p>El administrador no ha otorgado acceso a este apartado.</p></div>';
    return Promise.resolve();
  }
  const action = k === 'dashboard' ? vistaDashboard
    : k === 'importar' ? vistaImportar
    : k === 'misAsignaciones' ? vistaMisAsignaciones
    : k === 'miAvance' ? vistaMiAvance
    : k === 'cargasPanel' ? vistaCargasPanel
    : k === 'asignaciones' ? vistaAsignacionesGeneral
    : k === 'avance' ? vistaAvanceGeneral
    : () => vistaTab(k);
  return Promise.resolve().then(action).catch(e => {
    console.error('Error en la vista', k, e);
    main.innerHTML = `<div class="empty"><h3>No se pudo cargar esta sección</h3><p>${esc(e?.message || 'Error desconocido')}</p><button id="reintentar" class="p">Reintentar</button></div>`;
    $('reintentar').onclick = () => ir(k);
  });
}

function fecha(v) { if (!v) return ''; if (typeof v.toDate === 'function') return v.toDate().toLocaleString('es-MX'); return String(v); }
function options(list, value = '') { return list.map(x => `<option value="${esc(x)}" ${String(x) === String(value) ? 'selected' : ''}>${esc(x)}</option>`).join(''); }

async function getCatalog(col, filtro = null) {
  let q = collection(db, col); if (filtro) q = query(q, where(...filtro));
  return (await getDocs(q)).docs.map(d => ({ id: d.id, ...d.data() }));
}

function groupKey(nombre, tipo='') {
  return `${normalizarCatalogo('grupos', nombre)}|${normalizarCatalogo('grupos', tipo)}`;
}

function recordDocente(r) { return normEmail(r?.docente || r?.correo || r?.profesor || r?.teacher || ''); }
function recordGrupo(r) { return String(r?.grupo || r?.grupoNombre || r?.group || '').trim(); }
function recordMateria(r) { return String(r?.materia || r?.asignatura || r?.subject || '').trim(); }
function recordTipo(r) { return String(r?.tipo || r?.idioma || '').trim().toUpperCase().replace('INGLÉS','INGLES').replace('ESPAÑOL','ESPAÑOL'); }

function inferTipo(grupo, grupos) {
  const n = normalizarCatalogo('grupos', grupo);
  const hit = grupos.find(g => normalizarCatalogo('grupos', g.nombre) === n);
  return hit ? String(hit.tipo || '').toUpperCase() : '';
}

async function obtenerDatosGenerales() {
  const [docs, av, asig, cal, alumnos, grupos, mats] = await Promise.all([
    getDocs(collection(db, 'docentes')), getDocs(collection(db, 'avance')), getDocs(collection(db, 'asignaciones')),
    getDocs(collection(db, 'calificaciones')), getDocs(collection(db, 'alumnos')), getDocs(collection(db, 'grupos')), getDocs(collection(db, 'asignaturas'))
  ]);
  const docentes = docs.docs.map(x => ({id:x.id,...x.data()})).filter(x => ['docente','directivo'].includes(String(x.rol||'').toLowerCase()));
  const avances = av.docs.map(x => ({id:x.id,...x.data()}));
  const asignaciones = asig.docs.map(x => ({id:x.id,...x.data()}));
  const califs = cal.docs.map(x => ({id:x.id,...x.data()}));
  const alumnosRows = alumnos.docs.map(x => ({id:x.id,...x.data()}));
  const gruposRows = grupos.docs.map(x => ({id:x.id,...x.data()}));
  const matsRows = mats.docs.map(x => ({id:x.id,...x.data()}));

  // Una carga real es la combinación DOCENTE + GRUPO + MATERIA.
  // Primero usamos avance/asignaciones y luego completamos con calificaciones
  // antiguas, para que los datos ya existentes en producción no desaparezcan.
  const cargasMap = new Map();
  const califsPorCarga = new Map();
  const alumnosPorCarga = new Map();
  for (const c of califs) {
    const docente = recordDocente(c), grupo = recordGrupo(c), materia = recordMateria(c);
    if (!docente || !grupo || !materia) continue;
    const key = `${docente}|${normalizarCatalogo('grupos', grupo)}|${normalizarCatalogo('grupos', materia)}`;
    califsPorCarga.set(key, (califsPorCarga.get(key) || 0) + 1);
    const correo = normEmail(c.correo || '');
    if (correo) {
      if (!alumnosPorCarga.has(key)) alumnosPorCarga.set(key, new Set());
      alumnosPorCarga.get(key).add(correo);
    }
  }

  const addCarga = (r, source) => {
    const docente = recordDocente(r), grupo = recordGrupo(r), materia = recordMateria(r);
    if (!docente || !grupo || !materia) return;
    const key = `${docente}|${normalizarCatalogo('grupos', grupo)}|${normalizarCatalogo('grupos', materia)}`;
    const old = cargasMap.get(key) || {
      id: r.id || '', docente, grupo, materia,
      tipo: recordTipo(r) || inferTipo(grupo, gruposRows),
      filas: 0, alumnos: 0, estado: 'CARGADO', url: '', fecha: '',
      sources: new Set()
    };
    old.sources.add(source);
    old.tipo = old.tipo || recordTipo(r) || inferTipo(grupo, gruposRows);
    old.filas = Math.max(old.filas, Number(r.filas) || 0);
    old.alumnos = Math.max(old.alumnos, Number(r.alumnos) || 0);
    old.url = old.url || String(r.url || '');
    old.fecha = old.fecha || r.fecha || r.actualizado || '';
    if (r.estado) old.estado = r.estado;
    cargasMap.set(key, old);
  };

  avances.forEach(x => addCarga(x, 'avance'));
  asignaciones.forEach(x => addCarga(x, 'asignacion'));
  califs.forEach(x => addCarga(x, 'calificacion'));

  for (const [key, carga] of cargasMap) {
    carga.filas = Math.max(carga.filas, califsPorCarga.get(key) || 0);
    carga.alumnos = Math.max(carga.alumnos, alumnosPorCarga.get(key)?.size || 0);
  }

  // Asignaciones visibles: si la colección asignaciones está vacía o incompleta,
  // se reconstruye visualmente desde avance/calificaciones sin modificar Firebase.
  const asignacionesMap = new Map();
  for (const a of asignaciones) {
    const docente=recordDocente(a), grupo=recordGrupo(a), materia=recordMateria(a);
    if (!docente || !grupo || !materia) continue;
    const key=`${docente}|${normalizarCatalogo('grupos',grupo)}|${normalizarCatalogo('grupos',materia)}`;
    asignacionesMap.set(key, {...a, docente, grupo, materia, tipo:recordTipo(a)||inferTipo(grupo,gruposRows)});
  }
  for (const c of cargasMap.values()) {
    const key=`${c.docente}|${normalizarCatalogo('grupos',c.grupo)}|${normalizarCatalogo('grupos',c.materia)}`;
    const prev=asignacionesMap.get(key) || {};
    asignacionesMap.set(key, {
      ...prev, docente:c.docente, grupo:c.grupo, materia:c.materia,
      tipo:prev.tipo || c.tipo || inferTipo(c.grupo,gruposRows),
      url:prev.url || c.url || '', estado:prev.estado || c.estado || 'CARGADO',
      filas:c.filas, alumnos:c.alumnos, fecha:prev.fecha || c.fecha || '',
      fuente:prev.id ? 'asignacion' : 'carga detectada'
    });
  }

  return {
    docentes, avances, asignaciones, califs, alumnos:alumnosRows, grupos:gruposRows, mats:matsRows,
    cargas:[...cargasMap.values()],
    asignacionesVisibles:[...asignacionesMap.values()]
  };
}

function cargaTieneGrupo(c, g) {
  const gt = String(g.tipo || '').toUpperCase();
  const ct = String(c.tipo || '').toUpperCase();
  return normalizarCatalogo('grupos', c.grupo) === normalizarCatalogo('grupos', g.nombre)
    && (!gt || !ct || gt === ct);
}

async function vistaDashboard() {
  if (me.rol === 'admin' || me.rol === 'directivo') {
    const d = await obtenerDatosGenerales();
    const cargas = d.cargas;
    const gruposCargados = d.grupos.filter(g => cargas.some(c => cargaTieneGrupo(c, g)));
    const pendientes = d.grupos.filter(g => !cargas.some(c => cargaTieneGrupo(c, g)));
    const registros = cargas.reduce((s,c)=>s+(Number(c.filas)||0),0);
    const alumnosDetectados = new Set();
    d.califs.forEach(c => { const e=normEmail(c.correo||''); if(e) alumnosDetectados.add(e); });
    d.alumnos.forEach(a => { const e=normEmail(a.correo||''); if(e) alumnosDetectados.add(e); });

    const estadoGrupos = d.grupos.map(g => {
      const rows=cargas.filter(c=>cargaTieneGrupo(c,g));
      const docentes=[...new Set(rows.map(c=>c.docente).filter(Boolean))];
      const materias=[...new Set(rows.map(c=>c.materia).filter(Boolean))];
      const regs=rows.reduce((s,c)=>s+(Number(c.filas)||0),0);
      return `<tr><td><strong>${esc(g.nombre||'')}</strong></td><td>${esc(g.tipo||'')}</td><td><span class="status ${rows.length?'ok':'pending'}">${rows.length?'CARGADO':'PENDIENTE'}</span></td><td>${rows.length}</td><td>${esc(docentes.map(e=>d.docentes.find(x=>normEmail(x.correo)===normEmail(e))?.nombre||e).join(', ')||'—')}</td><td>${esc(materias.join(', ')||'—')}</td><td>${regs}</td></tr>`;
    }).join('');

    const docenteRows=d.docentes.map(t=>{
      const mine=cargas.filter(c=>normEmail(c.docente)===normEmail(t.correo));
      const detalle=mine.map(c=>`${c.grupo} · ${c.materia} (${Number(c.filas)||0})`).join(' | ');
      return `<tr><td>${t.foto?`<img class="avatar-sm" src="${esc(t.foto)}" alt="Foto">`:'<div class="avatar-placeholder">—</div>'}</td><td><strong>${esc(t.nombre||t.correo)}</strong><small class="cell-sub">${esc(t.correo||'')}</small></td><td>${mine.length}</td><td>${mine.reduce((s,c)=>s+(Number(c.filas)||0),0)}</td><td>${esc(detalle||'Sin cargas registradas')}</td></tr>`;
    }).join('');

    const cargaRows=cargas.map(c=>`<tr><td>${esc(d.docentes.find(x=>normEmail(x.correo)===normEmail(c.docente))?.nombre||c.docente)}</td><td>${esc(c.grupo)}</td><td>${esc(c.tipo||'')}</td><td>${esc(c.materia)}</td><td>${Number(c.alumnos)||0}</td><td><strong>${Number(c.filas)||0}</strong></td><td><span class="status ${String(c.estado||'CARGADO').toUpperCase()==='CARGADO'?'ok':'pending'}">${esc(c.estado||'CARGADO')}</span></td><td>${esc([...c.sources].join(', '))}</td></tr>`).join('');

    main.innerHTML=`<div class="section-head"><div><h2>${me.rol === 'admin' ? 'Dashboard del administrador' : 'Dashboard general'}</h2><p>Resumen real de grupos, docentes, cargas y registros encontrados en Firebase.</p></div></div>
      <div class="cards dashboard-cards"><div><b>${d.docentes.length}</b><span>Docentes</span></div><div><b>${d.grupos.length}</b><span>Grupos</span></div><div><b>${gruposCargados.length}</b><span>Grupos con carga</span></div><div><b>${cargas.length}</b><span>Cargas docente · grupo · materia</span></div><div><b>${registros}</b><span>Registros importados</span></div><div><b>${alumnosDetectados.size}</b><span>Alumnos detectados</span></div><div><b>${d.califs.length}</b><span>Calificaciones</span></div><div><b>${d.mats.length}</b><span>Asignaturas</span></div></div>
      <section class="dashboard-section"><div class="section-title"><div><h3>Estado de grupos</h3><p>Cada grupo se marca como cargado solo cuando existe una carga del mismo grupo y tipo.</p></div><span class="section-count">${gruposCargados.length} / ${d.grupos.length}</span></div><div class="table-wrap"><table><thead><tr><th>Grupo</th><th>Tipo</th><th>Estado</th><th>Cargas</th><th>Docente(s)</th><th>Materia(s)</th><th>Registros</th></tr></thead><tbody>${estadoGrupos||'<tr><td colspan="7" class="empty">No hay grupos registrados.</td></tr>'}</tbody></table></div>${pendientes.length?`<p class="muted"><strong>Pendientes:</strong> ${esc(pendientes.map(g=>`${g.nombre} (${g.tipo||'sin tipo'})`).join(', '))}</p>`:''}</section>
      <section class="dashboard-section"><div class="section-title"><div><h3>Docentes y sus cargas</h3><p>Se muestra qué grupo y materia cargó cada docente y cuántos registros produjo.</p></div></div><div class="table-wrap"><table><thead><tr><th>Foto</th><th>Docente</th><th>Cargas</th><th>Registros</th><th>Detalle de cargas</th></tr></thead><tbody>${docenteRows||'<tr><td colspan="5" class="empty">No hay docentes.</td></tr>'}</tbody></table></div></section>
      <section class="dashboard-section"><div class="section-title"><div><h3>Detalle de cargas detectadas</h3><p>Esta es la fuente que alimenta los números del dashboard. No se cuentan grupos duplicados como cargas independientes.</p></div><span class="section-count">${cargas.length}</span></div><div class="table-wrap"><table><thead><tr><th>Docente</th><th>Grupo</th><th>Tipo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Origen</th></tr></thead><tbody>${cargaRows||'<tr><td colspan="8" class="empty">No hay cargas registradas.</td></tr>'}</tbody></table></div></section>`;
    return;
  }

  const [av, asig, cal, grupos] = await Promise.all([
    getCatalog('avance',['docente','==',me.email]), getCatalog('asignaciones',['docente','==',me.email]),
    getCatalog('calificaciones',['docente','==',me.email]), getCatalog('grupos')
  ]);
  const map=new Map();
  const add=(a)=>{const grupo=recordGrupo(a), materia=recordMateria(a);if(!grupo||!materia)return;const key=`${normalizarCatalogo('grupos',grupo)}|${normalizarCatalogo('grupos',materia)}`;map.set(key,{...map.get(key),...a,grupo,materia,tipo:recordTipo(a)||inferTipo(grupo,grupos)});};
  [...av,...asig].forEach(add);
  const counts=new Map(); const alumnosMap=new Map();
  cal.forEach(c=>{const grupo=recordGrupo(c),materia=recordMateria(c);if(!grupo||!materia)return;const key=`${normalizarCatalogo('grupos',grupo)}|${normalizarCatalogo('grupos',materia)}`;counts.set(key,(counts.get(key)||0)+1);if(c.correo){if(!alumnosMap.has(key))alumnosMap.set(key,new Set());alumnosMap.get(key).add(normEmail(c.correo));}add(c);});
  for(const [key,n] of counts){const x=map.get(key);if(x)x.filas=Math.max(Number(x.filas)||0,n);}
  for(const [key,set] of alumnosMap){const x=map.get(key);if(x)x.alumnos=Math.max(Number(x.alumnos)||0,set.size);}
  const ds=[...map.values()];
  const total=ds.reduce((s,a)=>s+(Number(a.filas)||0),0);
  const alumnos=new Set();
  ds.forEach(a=>{
    const key=`${normalizarCatalogo('grupos',a.grupo)}|${normalizarCatalogo('grupos',a.materia)}`;
    const set=alumnosMap.get(key);
    if(set) set.forEach(x=>alumnos.add(x));
  });
  const alumnosTotal=alumnos.size;
  main.innerHTML=`<div class="perfil">${me.foto?`<img src="${esc(me.foto)}" alt="Foto">`:''}<div><h2>Hola, ${esc(me.nombre)}</h2><p>${esc(me.email)} · ${esc(me.rol)}</p></div></div><div class="cards"><div><b>${ds.length}</b><span>Cargas realizadas</span></div><div><b>${alumnosTotal}</b><span>Alumnos detectados</span></div><div><b>${total}</b><span>Registros importados</span></div><div><b>${cal.length}</b><span>Calificaciones</span></div></div><div class="acciones"><button class="p" id="nueva">+ Cargar nuevo reporte</button></div><section class="dashboard-section"><div class="section-title"><div><h3>Mis grupos cargados</h3><p>Aquí ves exactamente qué grupo cargaste, de qué tipo es, la materia y cuántos registros produjo.</p></div></div>${ds.length?`<div class="table-wrap"><table><thead><tr><th>Grupo</th><th>Tipo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>${ds.map(a=>`<tr><td><strong>${esc(a.grupo)}</strong></td><td>${esc(a.tipo||'')}</td><td>${esc(a.materia)}</td><td>${Number(a.alumnos)||0}</td><td><strong>${Number(a.filas)||0}</strong></td><td><span class="status ${String(a.estado||'CARGADO').toUpperCase()==='CARGADO'?'ok':'pending'}">${esc(a.estado||'CARGADO')}</span></td><td>${fecha(a.fecha||a.actualizado)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Todavía no hay cargas asociadas a tu cuenta.</div>'}</section>`;
  $('nueva').onclick=()=>ir('importar');
}

async function vistaImportar() {
  await auth.currentUser?.getIdToken(true);
  const [rows, gruposES, gruposEN, mats] = await Promise.all([
    getCatalog('asignaciones', ['docente','==',me.email]),
    getCatalog('grupos',['tipo','==','ESPAÑOL']),
    getCatalog('grupos',['tipo','==','INGLES']),
    getCatalog('asignaturas')
  ]);
  const grupos = [...gruposES.map(x => ({...x, tipo:'ESPAÑOL'})), ...gruposEN.map(x => ({...x, tipo:'INGLES'}))];
  main.innerHTML = `<h2>Cargar reportes de Classroom</h2><p>Selecciona grupo, materia y pega el enlace del reporte. Las filas anteriores quedan guardadas y pueden editarse.</p><div id="filas"></div>
    <button id="mas">+ Agregar fila</button> <button class="p" id="go">IMPORTAR REPORTES</button><pre id="log"></pre>`;
  const add = (g = '', m = '', u = '', tipo = '') => {
    const d = document.createElement('div'); d.className = 'fila carga-row';
    d.innerHTML = `<select class="tipo"><option value="">TIPO</option><option value="ESPAÑOL" ${String(tipo).toUpperCase()==='ESPAÑOL'?'selected':''}>ESPAÑOL</option><option value="INGLES" ${String(tipo).toUpperCase()==='INGLES'?'selected':''}>INGLES</option></select>
      <select class="g"><option value="">Grupo</option></select><select class="m"><option value="">Materia</option>${options(mats.map(x => x.nombre),m)}</select>
      <input class="u" placeholder="Pegar enlace de Google Sheets" value="${esc(u)}"><button class="danger quitar">Quitar</button>`;
    $('filas').append(d);
    const sync = () => {
      const tg = d.querySelector('.tipo').value;
      const gs = grupos.filter(x => String(x.tipo || '').toUpperCase() === String(tg || '').toUpperCase()).map(x => x.nombre);
      d.querySelector('.g').innerHTML = `<option value="">Grupo</option>${options(gs,g)}`;
    };
    d.querySelector('.tipo').onchange = sync;
    d.querySelector('.quitar').onclick = () => d.remove();
    sync();
  };
  rows.forEach(r => add(r.grupo, r.materia, r.url || '', r.tipo || (gruposES.some(x=>normalizarCatalogo('grupos',x.nombre)===normalizarCatalogo('grupos',r.grupo))?'ESPAÑOL':'INGLES')));
  if (!rows.length) add();
  $('mas').onclick = () => add();
  $('go').onclick = importar;
}

async function leer(url) {
  if (!BRIDGE_URL || !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(BRIDGE_URL)) {
    throw new Error('El puente de Google Sheets no está configurado. Revisa BRIDGE_URL en public/config.js.');
  }
  const cleanUrl = String(url || '').trim();
  if (!/https?:\/\/(docs\.google\.com|drive\.google\.com)\//i.test(cleanUrl)) {
    throw new Error('El enlace no parece ser de Google Drive/Google Sheets.');
  }
  const token = await auth.currentUser.getIdToken(true);
  const r = await fetch(BRIDGE_URL, {
    method:'POST',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body:JSON.stringify({idToken:token,url:cleanUrl})
  });
  if (!r.ok) throw new Error(`El puente respondió HTTP ${r.status}.`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'El puente no pudo leer el reporte.');
  if (!Array.isArray(j.datos) || !j.datos.length) throw new Error('El reporte está vacío.');
  return j.datos;
}

function parsear(d, it) {
  const [fechas = [], acts = []] = [d[0] || [], d[1] || []], out = [], alumnos = new Map();
  for (let i=2;i<d.length;i++) {
    const f=d[i]||[], s=f.join(' ').toLowerCase(); if (s.includes('media de la clase')||s.includes('abrir classroom')) continue;
    const ie=f.findIndex(c=>String(c).includes('@')); if(ie<0) continue;
    const correo=normEmail(f[ie]); if(!correo) continue;
    const alumno=f.slice(0,ie).filter(c=>c&&String(c).trim()).join(' ').trim()||'Alumno';
    alumnos.set(correo,{correo,nombre:alumno,grupo:it.grupo});
    for(let c=ie+1;c<f.length;c++){
      const fecha=String(fechas[c]??'').trim(), act=String(acts[c]??'').trim(); if(!fecha&&!act) continue;
      let n=parseFloat(String(f[c]).replace(',','.')); if(isNaN(n)) n=0; if(n>10)n=Math.min(n/10,10);
      out.push({docente:me.email,profesor:me.nombre,grupo:it.grupo,alumno,correo,fecha,actividad:act,calif:n,asignatura:it.materia});
    }
  }
  return {rows:out,alumnos:[...alumnos.values()]};
}

async function importar(){
  const log=m=>$('log').textContent+=m+'\n'; $('log').textContent=''; $('go').disabled=true;
  // Revalida el perfil antes de escribir. Evita el fallo de permisos cuando
  // la cuenta inició sesión antes de que su documento de docente existiera.
  try {
    await auth.currentUser?.getIdToken(true);
    const perfilRef = doc(db, 'docentes', me.email);
    const perfilSnap = await getDoc(perfilRef);
    const rol = String(perfilSnap.data()?.rol || '').trim().toLowerCase();
    if (!perfilSnap.exists() || !['docente','admin'].includes(rol)) {
      log('❌ Tu cuenta no tiene un perfil docente válido en Firestore.');
      log(`Correo: ${me.email}`);
      log('El administrador debe confirmar este correo en Firestore > docentes y usar rol "docente".');
      $('go').disabled=false; return;
    }
  } catch(e) {
    log(`❌ No se pudo validar el perfil: ${e.code || 'error'} — ${e.message}`);
    $('go').disabled=false; return;
  }
  const vistos=new Set(),items=[];
  document.querySelectorAll('.carga-row').forEach(d=>{const it={tipo:d.querySelector('.tipo').value,grupo:d.querySelector('.g').value.trim(),materia:d.querySelector('.m').value.trim(),url:d.querySelector('.u').value.trim()};if(it.grupo&&it.materia&&it.url&&!vistos.has(it.url)){vistos.add(it.url);items.push(it);}});
  if(!items.length){log('No hay filas completas. Selecciona tipo, grupo, materia y enlace.');$('go').disabled=false;return;}
  log(`Leyendo ${items.length} archivo(s)...`);
  // Procesamos los reportes uno por uno. En producción, lanzar 10 peticiones
  // simultáneas al Apps Script puede provocar límites/throttling y dejar al
  // docente con la sensación de que ninguna fila se envió. Cada fila queda
  // registrada por separado y un fallo no cancela las demás.
  let total=0;
  for(const it of items){
    let r;
    try { r={it, parsed:parsear(await leer(it.url),it)}; }
    catch(e) { r={it, err:e.message}; }
    if(r.err){log(`❌ ${r.it.grupo}: ${r.err}`);continue;}
    const {rows,alumnos}=r.parsed;
    try {
      if(rows.length){
        for(let i=0;i<rows.length;i+=450){
          const b=writeBatch(db);
          rows.slice(i,i+450).forEach(x=>b.set(doc(db,'calificaciones',hash([me.email,x.grupo,x.asignatura,x.correo,x.actividad,x.fecha].join('|'))),normalizarGuardado(x),{merge:true}));
          await b.commit();
        }
      }
      log(`✓ Calificaciones guardadas: ${rows.length}`);
      // Los alumnos también se guardan por lotes para que una carga de muchos
      // alumnos no haga decenas/centenas de escrituras independientes.
      for(let i=0;i<alumnos.length;i+=450){
        const b=writeBatch(db);
        alumnos.slice(i,i+450).forEach(a=>b.set(
          doc(db,'alumnos',a.correo),
          normalizarGuardado({correo:a.correo,nombre:a.nombre,grupos:arrayUnion(String(a.grupo||'').trim().replace(/\s+/g,' ').toUpperCase()),ultimoDocente:me.email,actualizado:serverTimestamp()}),
          {merge:true}
        ));
        await b.commit();
      }
      log(`✓ Alumnos actualizados: ${alumnos.length}`);
      const aid=hash([me.email,r.it.grupo,r.it.materia].join('|'));
      await setDoc(doc(db,'asignaciones',aid),normalizarGuardado({docente:me.email,nombre:me.nombre,grupo:r.it.grupo,materia:r.it.materia,tipo:r.it.tipo||'CLASSROOM',url:r.it.url,actualizado:serverTimestamp()}),{merge:true});
      log('✓ Asignación guardada');
      await setDoc(doc(db,'avance',aid),normalizarGuardado({docente:me.email,nombre:me.nombre,grupo:r.it.grupo,asignatura:r.it.materia,filas:rows.length,alumnos:alumnos.length,url:r.it.url,estado:'CARGADO',fecha:serverTimestamp()}),{merge:true});
      log('✓ Avance guardado');
      total+=rows.length; log(`✅ ${r.it.grupo} · ${r.it.materia}: ${rows.length} registros · ${alumnos.length} alumnos`);
    } catch(e) {
      console.error('Error Firestore al importar', e, r.it);
      log(`❌ FIRESTORE en ${r.it.grupo} · ${r.it.materia}: ${e.code || 'error'} — ${e.message}`);
      log('Revisa que tu correo tenga un documento en Firestore > docentes con rol "docente" y que las reglas publicadas sean las del proyecto.');
    }
  }
  if (total === 0) log(`⚠️ No se guardaron calificaciones. Revisa los errores anteriores.`);
  else log(`Listo, ${me.nombre||me.email}. ${total} registros guardados.`);
  $('go').disabled=false;
}


async function guardar(t, objs){
  for(let i=0;i<objs.length;i+=450){
    const b=writeBatch(db);
    objs.slice(i,i+450).forEach(raw=>{
      let o=normalizarGuardado({...t.def,...raw,...t.fix});
      const existingId=o._id; delete o._id;
      const id=existingId || (t.key ? (t.col === 'grupos' ? hash([o.nombre, o.tipo].map(v=>String(v||'').trim().toUpperCase()).join('|')) : String(o[t.key]||'').toLowerCase().trim()) : hash(t.f.map(f=>o[f]??'').join('|')+(t.fix?.tipo??'')));
      if(!id)return;
      if(t.key && t.key !== 'correo') o[t.key]=String(o[t.key]||'').trim().toUpperCase();
      b.set(doc(db,t.col,id),o,{merge:true});
    });
    await b.commit();
  }
}

function formFields(t, data={}){
  return t.f.map(f=>{
    const v=data[f] ?? '';
    if(t.types?.[f]) return `<label>${f}<select id="n_${f}"><option value="">Selecciona</option>${options(t.types[f],v)}</select></label>`;
    if(f==='grupos') return `<label>${f}<input id="n_${f}" value="${esc(Array.isArray(v)?v.join(', '):v)}" placeholder="Separados por coma"></label>`;
    if(f==='estado') return `<label>${f}<select id="n_${f}">${options(['CARGADO','PENDIENTE','REVISAR','CORREGIDO'],String(v||'CARGADO').toUpperCase())}</select></label>`;
    const label = ({grupoEspanol:'Grupo Español',grupoIngles:'Grupo Inglés',matricula:'Matrícula'}[f] || f);
    return `<label>${label}<input id="n_${f}" value="${esc(v)}" placeholder="${label}" ${data.id && t.key === f ? 'readonly' : ''}></label>`;
  }).join('');
}

function esCargaMasiva(k) { return ['gruposES', 'gruposEN', 'asignaturas', 'alumnos'].includes(k); }
function descargarPlantillaAlumnos() {
  if (!window.XLSX) return alert('No se pudo cargar el generador de Excel. Recarga la página e inténtalo de nuevo.');
  const headers = [['MATRICULA', 'NOMBRE', 'CORREO', 'GRUPO ESPAÑOL', 'GRUPO INGLES', 'TUTOR']];
  const ws = XLSX.utils.aoa_to_sheet(headers);
  ws['!cols'] = [{wch:16},{wch:30},{wch:32},{wch:18},{wch:18},{wch:30}];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'ALUMNOS');
  XLSX.writeFile(wb, 'PLANTILLA_ALUMNOS.xlsx');
}

function normalizarFilaAlumno(r) {
  return {
    matricula: String(r.matricula ?? '').trim(),
    nombre: String(r.nombre ?? '').trim(),
    correo: normEmail(r.correo),
    grupoEspanol: String(r.grupoEspanol ?? '').trim(),
    grupoIngles: String(r.grupoIngles ?? '').trim(),
    tutor: String(r.tutor ?? '').trim()
  };
}

function leerExcelAlumnos(file) {
  return new Promise((resolve, reject) => {
    if (!window.XLSX) return reject(new Error('No se pudo cargar el lector de Excel. Recarga la página.'));
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
        const aliases = {
          'MATRICULA':'matricula','NOMBRE':'nombre','CORREO':'correo','GRUPO ESPAÑOL':'grupoEspanol',
          'GRUPO ESPANOL':'grupoEspanol','GRUPO INGLES':'grupoIngles','GRUPO INGLÉS':'grupoIngles','TUTOR':'tutor'
        };
        const rows = data.map(row => {
          const x = {};
          Object.entries(row).forEach(([key,val]) => { const clean = String(key).trim().toUpperCase(); if (aliases[clean]) x[aliases[clean]] = val; });
          return normalizarFilaAlumno(x);
        }).filter(r => r.matricula || r.nombre || r.correo);
        resolve(rows);
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsArrayBuffer(file);
  });
}

function normalizarCatalogo(k, value) { return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase(); }

function normalizarGuardado(obj) {
  const protectedFields = new Set(['correo', 'docente', 'rol', 'url', 'foto', 'permisos']);
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) { out[key] = value; continue; }
    if (Array.isArray(value)) {
      out[key] = value.map(v => typeof v === 'string' && !protectedFields.has(key) ? v.trim().replace(/\s+/g, ' ').toUpperCase() : v);
    } else if (typeof value === 'string' && !protectedFields.has(key)) {
      out[key] = value.trim().replace(/\s+/g, ' ').toUpperCase();
    } else {
      out[key] = value;
    }
  }
  if (out.correo) out.correo = normEmail(out.correo);
  if (out.docente) out.docente = normEmail(out.docente);
  if (Array.isArray(out.grupos)) out.grupos = out.grupos.map(v => String(v).trim().replace(/\s+/g, ' ').toUpperCase());
  return out;
}

function parsearPegado(k, texto) {
  const lineas = String(texto || '').replace(/\r/g, '').split('\n').filter(x => x.trim());
  const sep = lineas.some(x => x.includes('\t')) ? '\t' : ',';
  const rows = [];
  for (const linea of lineas) {
    const c = linea.split(sep).map(x => x.trim());
    if (k === 'alumnos') {
      if (/^matricula\s*(nombre|correo)/i.test(c[0] || '')) continue;
      rows.push(normalizarFilaAlumno({matricula:c[0],nombre:c[1],correo:c[2],grupoEspanol:c[3],grupoIngles:c[4],tutor:c[5]}));
    } else if (k === 'asignaturas') {
      if (!c[0]) continue;
      const tipo = c[1] || 'ESPAÑOL';
      if (/^(nombre|asignatura|materia)$/i.test(c[0]) && (!c[1] || /^(tipo|idioma)$/i.test(c[1]))) continue;
      rows.push({ nombre: c[0], tipo: ['INGLES', 'INGLÉS'].includes(String(tipo).toUpperCase()) ? 'INGLES' : String(tipo).toUpperCase() });
    } else {
      if (!c[0]) continue;
      if (/^(nombre|grupo)$/i.test(c[0])) continue;
      rows.push({ nombre: c[0] });
    }
  }
  return rows;
}

function alumnoClave(r) { return `${String(r.matricula||'').trim().toUpperCase()}|${normEmail(r.correo)}`; }
function alumnoDup(r, existing) {
  const m = String(r.matricula||'').trim().toUpperCase(), c = normEmail(r.correo);
  return existing.some(x => (m && String(x.matricula||'').trim().toUpperCase() === m) || (c && normEmail(x.correo) === c));
}

function renderBulkEditor(k, rows, existing) {
  const editor = $('bulkEditor');
  const fields = k === 'asignaturas' ? ['nombre', 'tipo'] : k === 'alumnos' ? ['matricula','nombre','correo','grupoEspanol','grupoIngles','tutor'] : ['nombre'];
  const labels = {matricula:'Matrícula',nombre:k==='asignaturas'?'Materia':'Nombre',correo:'Correo',grupoEspanol:'Grupo Español',grupoIngles:'Grupo Inglés',tutor:'Tutor',tipo:'Tipo'};
  const state = rows.map((r, i) => ({ ...r, _i: i, _remove: false }));
  const duplicateFor = r => k === 'alumnos' ? alumnoDup(r, existing) : existing.some(x => normalizarCatalogo(k, x.nombre) === normalizarCatalogo(k, r.nombre));
  const duplicatePasteFor = r => state.some(x => !x._remove && x._i !== r._i && (k === 'alumnos' ? ((r.matricula && String(x.matricula).trim().toUpperCase() === String(r.matricula).trim().toUpperCase()) || (r.correo && normEmail(x.correo) === normEmail(r.correo))) : normalizarCatalogo(k, x.nombre) === normalizarCatalogo(k, r.nombre)));
  const body = () => state.filter(r => !r._remove).map(r => {
    const duplicateExisting = duplicateFor(r), duplicatePaste = duplicatePasteFor(r), duplicate = duplicateExisting || duplicatePaste;
    const motivo = duplicateExisting ? 'YA EXISTE' : (duplicatePaste ? 'REPETIDA EN EL PEGADO/ARCHIVO' : '');
    return `<tr class="bulk-row ${duplicate ? 'duplicate' : ''}" data-i="${r._i}">
      <td>${r._i + 1}</td>${fields.map(f => `<td><input class="bulk-input" data-f="${f}" value="${esc(r[f] || '')}" ${f === 'tipo' ? 'list="tipos-materia"' : ''}></td>`).join('')}
      <td>${duplicate ? `<span class="bulk-warning">⚠ ${esc(motivo)}</span>` : '<span class="bulk-ok">✓ NUEVO' + (k==='alumnos' ? ' · LISTO' : '') + '</span>'}</td><td><button type="button" class="danger bulk-remove" data-i="${r._i}">Eliminar</button></td></tr>`;
  }).join('');
  editor.innerHTML = `<div class="bulk-head"><div><h3>Revisar ${k==='alumnos'?'alumnos':'filas'}</h3><p>${state.filter(r => !r._remove).length} fila(s). Las filas amarillas ya existen o están repetidas.</p></div><div class="actions"><button type="button" id="bulkCancelar">Cancelar</button><button type="button" class="p" id="bulkGuardar">CONFIRMAR Y GUARDAR TODO</button></div></div>
    ${k==='asignaturas' ? '<datalist id="tipos-materia"><option value="ESPAÑOL"><option value="INGLES"></datalist>' : ''}
    <div class="table-wrap"><table class="bulk-table"><thead><tr><th>#</th>${fields.map(f => `<th>${labels[f] || f}</th>`).join('')}<th>Estado</th><th>Acción</th></tr></thead><tbody>${body() || '<tr><td colspan="10" class="empty">No hay filas para guardar.</td></tr>'}</tbody></table></div>`;
  editor.hidden = false;
  editor.querySelectorAll('.bulk-input').forEach(inp => inp.oninput = () => {
    const r = state.find(x => String(x._i) === inp.closest('tr').dataset.i); if (r) r[inp.dataset.f] = inp.value.trim();
    const duplicate = duplicateFor(r) || duplicatePasteFor(r), tr = inp.closest('tr'), status = tr.querySelector('td:nth-last-child(2)');
    tr.classList.toggle('duplicate', duplicate); status.innerHTML = duplicate ? '<span class="bulk-warning">⚠ DUPLICADO</span>' : '<span class="bulk-ok">✓ NUEVO</span>';
  });
  editor.querySelectorAll('.bulk-remove').forEach(btn => btn.onclick = () => { const r = state.find(x => String(x._i) === btn.dataset.i); if (r) r._remove = true; renderBulkEditor(k, state, existing); });
  $('bulkCancelar').onclick = () => { editor.hidden = true; };
  $('bulkGuardar').onclick = async () => {
    const valid = state.filter(r => !r._remove).map(r => k==='alumnos' ? normalizarFilaAlumno(r) : r).filter(r => k==='alumnos' ? (r.matricula && r.nombre && r.correo) : r.nombre.trim());
    if (!valid.length) return alert('No hay filas válidas para guardar.');
    const finalKeys = new Set();
    for (const r of valid) {
      const key = k==='alumnos' ? alumnoClave(r) : normalizarCatalogo(k, r.nombre);
      if (duplicateFor(r)) return alert(`La fila "${r.nombre || r.matricula}" todavía está marcada como duplicada. Edítala o elimínala antes de guardar.`);
      if (finalKeys.has(key)) return alert(`La fila "${r.nombre || r.matricula}" está repetida en el archivo. Edítala o elimínala antes de guardar.`);
      finalKeys.add(key);
      if (k === 'asignaturas' && !['ESPAÑOL', 'INGLES'].includes(String(r.tipo).toUpperCase())) return alert(`Tipo inválido en "${r.nombre}". Usa Español o Ingles.`);
      if (k === 'alumnos' && !/^\S+@\S+\.\S+$/.test(r.correo)) return alert(`Correo inválido en la matrícula ${r.matricula}.`);
    }
    $('bulkGuardar').disabled = true;
    try { await guardar(TABS[k], valid); editor.hidden = true; vistaTab(k); }
    catch (e) { alert('No se pudieron guardar las filas: ' + e.message); $('bulkGuardar').disabled = false; }
  };
}

async function vistaTab(k) {
  if (k === 'docentes') return vistaDocentesPanel();
  const t=TABS[k];
  let q=collection(db,t.col);
  if(t.w && !['gruposES','gruposEN'].includes(k)) q=query(q,where(...t.w));
  const ds=(await getDocs(q)).docs;
  let rows=ds.map(d=>({id:d.id,...d.data()}));
  if(k==='gruposES') rows=rows.filter(r=>String(r.tipo||'').toUpperCase()==='ESPAÑOL');
  if(k==='gruposEN') rows=rows.filter(r=>String(r.tipo||'').toUpperCase()==='INGLES');
  const bulk=esCargaMasiva(k), alumnoBulk=k==='alumnos';
  main.innerHTML=`<div class="section-head"><div><h2>${t.n}</h2><p>${bulk ? (alumnoBulk ? 'Carga tu Excel o descarga la plantilla oficial. Revisa todos los alumnos antes de guardarlos.' : 'Agrega una por una o pega directamente varias filas copiadas de Google Sheets. Revisa todo antes de guardar.') : 'Agrega, edita y completa la información. Los cambios se guardan en Firestore.'}</p></div><div class="actions"><button class="p" id="nuevo">+ Nuevo</button>${alumnoBulk ? '<button id="plantillaAlumnos">DESCARGAR PLANTILLA EXCEL</button><label class="button-file" for="excelAlumnos">SUBIR EXCEL</label><input id="excelAlumnos" type="file" accept=".xlsx,.xls" hidden>' : bulk ? '<button id="pegarMasivo">Pegar desde Sheets</button>' : ''}</div></div>
    ${bulk ? `<div id="bulkPaste" class="bulk-paste" hidden><label>${alumnoBulk ? 'También puedes pegar las 6 columnas desde Excel/Sheets' : 'Pega aquí las filas copiadas de Google Sheets'}<textarea id="pasteArea" rows="7" placeholder="${alumnoBulk ? 'MATRICULA<TAB>NOMBRE<TAB>CORREO<TAB>GRUPO ESPAÑOL<TAB>GRUPO INGLES<TAB>TUTOR' : k === 'asignaturas' ? 'Materia<TAB>Tipo\nMATEMÁTICAS<TAB>ESPAÑOL\nENGLISH<TAB>INGLES' : 'Grupo\n1A\n1B\n2A'}"></textarea></label><div class="actions"><button id="procesarPegado" class="p">PREVISUALIZAR FILAS</button><button id="cancelarPegado">Cancelar</button></div></div><div id="bulkEditor" class="editor" hidden></div>` : '<div id="editor" class="editor" hidden></div>'}
    <div class="tools"><input id="buscar" placeholder="Buscar..."><button id="recargar">Actualizar</button></div>
    <div class="table-wrap"><table><thead><tr>${t.f.map(f=>`<th>${f}</th>`).join('')}<th>Acciones</th></tr></thead><tbody>${rows.map(r=>`<tr>${t.f.map(f=>`<td>${esc(Array.isArray(r[f])?r[f].join(', '):r[f])}</td>`).join('')}<td class="actions"><button data-edit="${esc(r.id)}">Editar</button><button class="danger" data-del="${esc(r.id)}">Borrar</button></td></tr>`).join('')||'<tr><td colspan="20" class="empty">No hay registros.</td></tr>'}</tbody></table></div>`;

  const editor=$('editor');
  const openEditor=(data={})=>{
    if (!editor) return;
    editor.hidden=false;
    editor.innerHTML=`<h3>${data.id?'Editar':'Nueva'} ${t.n}</h3><div class="form-grid">${formFields(t,data)}</div><div class="actions"><button class="p" id="guardarForm">Guardar</button><button id="cancelarForm">Cancelar</button></div>`;
    $('cancelarForm').onclick=()=>{editor.hidden=true};
    $('guardarForm').onclick=async()=>{const o={_id:data.id||''};t.f.forEach(f=>{let v=$('n_'+f)?.value.trim()||'';if(f==='correo'||f==='docente')v=normEmail(v);if(f==='grupos')v=v.split(',').map(x=>x.trim()).filter(Boolean);o[f]=v;});if(t.fix)Object.assign(o,t.fix);if(k==='docentes'&&o.correo===ADMIN_EMAIL.toLowerCase())o.rol='admin';if(!o[t.key||t.f[0]]&&!t.key)return alert('Completa los campos obligatorios.');try{await guardar(t,[o]);editor.hidden=true;vistaTab(k);}catch(e){alert('No se pudo guardar: '+e.message);}};
  };

  $('nuevo').onclick=()=>{
    if (bulk) {
      const blank=alumnoBulk ? {matricula:'',nombre:'',correo:'',grupoEspanol:'',grupoIngles:'',tutor:''} : {nombre:'' , ...(k==='asignaturas'?{tipo:'ESPAÑOL'}:{})};
      renderBulkEditor(k,[blank],rows);
      const bp=$('bulkPaste'); if(bp) bp.hidden=true;
      return;
    }
    openEditor();
  };
  if(bulk){
    if(alumnoBulk){
      $('plantillaAlumnos').onclick=descargarPlantillaAlumnos;
      $('excelAlumnos').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const parsed=await leerExcelAlumnos(file);if(!parsed.length)return alert('No encontré filas válidas.');renderBulkEditor(k,parsed,rows);}catch(err){alert('No se pudo leer el Excel: '+err.message);}e.target.value='';};
    } else {
      $('pegarMasivo').onclick=()=>{$('bulkPaste').hidden=!$('bulkPaste').hidden;if(!$('bulkPaste').hidden)$('pasteArea').focus();};
    }
    $('cancelarPegado').onclick=()=>{$('bulkPaste').hidden=true;$('pasteArea').value='';};
    $('procesarPegado').onclick=()=>{const parsed=parsearPegado(k,$('pasteArea').value);if(!parsed.length)return alert('No encontré filas válidas.');renderBulkEditor(k,parsed,rows);};
    $('pasteArea').addEventListener('paste',()=>setTimeout(()=>{const parsed=parsearPegado(k,$('pasteArea').value);if(parsed.length)renderBulkEditor(k,parsed,rows);},50));
  }
  main.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEditor(rows.find(r=>r.id===b.dataset.edit)));
  main.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('¿Borrar este registro?'))return;try{await deleteDoc(doc(db,t.col,b.dataset.del));vistaTab(k);}catch(e){alert('No se pudo borrar: '+e.message);}});
  $('recargar').onclick=()=>vistaTab(k);
  $('buscar').oninput=e=>{const term=e.target.value.toLowerCase();main.querySelectorAll('tbody tr').forEach(tr=>{tr.hidden=!tr.textContent.toLowerCase().includes(term);});};
}

async function vistaDocentesPanel(){
  const ds=(await getDocs(collection(db,'docentes'))).docs.map(d=>({id:d.id,...d.data()})).filter(d=>['docente','directivo'].includes(String(d.rol||'').toLowerCase()));
  let cargas=[]; try { const d=await obtenerDatosGenerales(); cargas=d.cargas; } catch(_) {}
  main.innerHTML=`<div class="section-head"><div><h2>Panel de docentes</h2><p>Consulta su foto, rol, privilegios, cargas y registros.</p></div><div class="actions"><button class="p" id="nuevoDoc">+ Nuevo perfil</button><button id="actualizarDocs">Actualizar</button></div></div><div class="table-wrap"><table><tr><th>Foto</th><th>Docente</th><th>Correo</th><th>Rol</th><th>Privilegios</th><th>Cargas</th><th>Registros</th><th>Acciones</th></tr>${ds.map(d=>{const mine=cargas.filter(c=>normEmail(c.docente)===normEmail(d.correo));return `<tr><td>${d.foto?`<img class="avatar-sm" src="${esc(d.foto)}" alt="Foto de ${esc(d.nombre||'docente')}">`:'<div class="avatar-placeholder">—</div>'}</td><td>${esc(d.nombre||'')}</td><td>${esc(d.correo||d.id)}</td><td><span class="role-badge">${esc(String(d.rol||'docente').toUpperCase())}</span></td><td>${esc((Array.isArray(d.permisos)?d.permisos:[]).map(p=>PRIVILEGES[p]||p).join(', ')||'—')}</td><td>${mine.length}</td><td>${mine.reduce((s,c)=>s+(Number(c.filas)||0),0)}</td><td class="actions"><button data-edit-doc2="${esc(d.id)}">Editar</button><button data-view-doc="${esc(d.correo)}">Ver cargas</button></td></tr>`}).join('')}</table></div>`;
  $('nuevoDoc').onclick=()=>editarDocente(null);
  $('actualizarDocs').onclick=()=>vistaDocentesPanel();
  main.querySelectorAll('[data-edit-doc2]').forEach(b=>b.onclick=()=>editarDocente(b.dataset.editDoc2));
  main.querySelectorAll('[data-view-doc]').forEach(b=>b.onclick=()=>vistaCargasPanel(b.dataset.viewDoc));
}

async function editarDocente(correo){
  const data=correo ? (await getDoc(doc(db,'docentes',correo))).data() || {} : {};
  const isAdmin = correo && normEmail(correo)===normEmail(ADMIN_EMAIL);
  const permisos=Array.isArray(data.permisos)?data.permisos:[];
  main.innerHTML=`<div class="editor"><h2>${correo?'Editar docente/directivo':'Nuevo docente/directivo'}</h2><div class="form-grid">
    <label>Correo<input id="edCorreo" value="${esc(correo||'')}" ${correo?'readonly':''}></label>
    <label>Nombre<input id="edNombre" value="${esc(data.nombre||'')}"></label>
    <label>Foto URL<input id="edFoto" value="${esc(data.foto||'')}" placeholder="URL de foto de Google"></label>
    <label>Rol<select id="edRol" ${isAdmin?'disabled':''}><option value="docente" ${data.rol==='docente'?'selected':''}>Docente</option><option value="directivo" ${data.rol==='directivo'?'selected':''}>Directivo</option><option value="admin" ${data.rol==='admin'?'selected':''}>Administrador</option></select></label>
  </div><h3>Privilegios del directivo</h3><div class="priv-grid">${Object.entries(PRIVILEGES).map(([k,n])=>`<label><input type="checkbox" class="priv-check" value="${k}" ${permisos.includes(k)?'checked':''}> ${esc(n)}</label>`).join('')}</div><div class="actions"><button id="cancelEd">Cancelar</button><button class="p" id="saveEd">Guardar privilegios y perfil</button></div></div>`;
  $('cancelEd').onclick=()=>vistaDocentesPanel();
  $('saveEd').onclick=async()=>{
    const em=normEmail($('edCorreo').value), rol=isAdmin?'admin':$('edRol').value, priv=[...document.querySelectorAll('.priv-check:checked')].map(x=>x.value);
    if(!em || !em.endsWith('@'+DOMINIO)) return alert('Usa un correo @ibime.edu.mx.');
    if(rol==='directivo' && !priv.length) return alert('Selecciona al menos un privilegio para el directivo.');
    try{ await setDoc(doc(db,'docentes',em),normalizarGuardado({correo:em,nombre:$('edNombre').value.trim(),foto:$('edFoto').value.trim(),rol,permisos:rol==='admin'?allPrivs():priv,actualizado:serverTimestamp()}),{merge:true}); alert('Perfil actualizado.'); vistaDocentesPanel(); }catch(e){alert('No se pudo guardar: '+e.message);}
  };
}

async function vistaCargasPanel(filtroDocente=''){
  const d=await obtenerDatosGenerales();
  const rows=filtroDocente?d.cargas.filter(c=>normEmail(c.docente)===normEmail(filtroDocente)):d.cargas;
  main.innerHTML=`<div class="section-head"><div><h2>Cargas y registros</h2><p>Una fila representa una combinación de docente + grupo + materia. Los registros provienen de avance y, si falta, de las calificaciones existentes.</p></div><button id="backDash">Dashboard</button></div><div class="tools"><input id="buscarCarga" placeholder="Buscar docente, grupo o materia..."><button id="refCargas">Actualizar</button></div><div class="table-wrap"><table><thead><tr><th>Docente</th><th>Grupo</th><th>Tipo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Origen</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(d.docentes.find(x=>normEmail(x.correo)===normEmail(r.docente))?.nombre||r.docente)}</td><td>${esc(r.grupo)}</td><td>${esc(r.tipo||'')}</td><td>${esc(r.materia)}</td><td>${Number(r.alumnos)||0}</td><td><strong>${Number(r.filas)||0}</strong></td><td><span class="status ${String(r.estado||'CARGADO').toUpperCase()==='CARGADO'?'ok':'pending'}">${esc(r.estado||'CARGADO')}</span></td><td>${esc([...r.sources].join(', '))}</td></tr>`).join('')||'<tr><td colspan="8" class="empty">No hay cargas registradas.</td></tr>'}</tbody></table></div>`;
  $('backDash').onclick=()=>ir('dashboard'); $('refCargas').onclick=()=>vistaCargasPanel(filtroDocente); $('buscarCarga').oninput=e=>{const term=e.target.value.toLowerCase();main.querySelectorAll('tbody tr').forEach(tr=>tr.hidden=!tr.textContent.toLowerCase().includes(term));};
}

async function vistaAsignacionesGeneral(){
  const d=await obtenerDatosGenerales();
  const rows=d.asignacionesVisibles.sort((a,b)=>`${a.docente}|${a.grupo}|${a.materia}`.localeCompare(`${b.docente}|${b.grupo}|${b.materia}`));
  main.innerHTML=`<div class="section-head"><div><h2>Asignaciones</h2><p>Relación real entre docente, grupo, materia y reporte. Si una carga antigua no tiene documento en <code>asignaciones</code>, se muestra desde sus registros para no perder información.</p></div><button id="refAsig">Actualizar</button></div><div class="table-wrap"><table><thead><tr><th>Docente</th><th>Grupo</th><th>Tipo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Reporte</th><th>Origen</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(d.docentes.find(x=>normEmail(x.correo)===normEmail(r.docente))?.nombre||r.docente||'')}</td><td>${esc(r.grupo||'')}</td><td>${esc(r.tipo||'')}</td><td>${esc(r.materia||r.asignatura||'')}</td><td>${Number(r.alumnos)||0}</td><td>${Number(r.filas)||0}</td><td><span class="status ${String(r.estado||'CARGADO').toUpperCase()==='CARGADO'?'ok':'pending'}">${esc(r.estado||'CARGADO')}</span></td><td>${r.url?`<a href="${esc(r.url)}" target="_blank" rel="noopener">Abrir reporte</a>`:'Sin enlace guardado'}</td><td>${esc(r.fuente||'asignacion')}</td></tr>`).join('')||'<tr><td colspan="9" class="empty">No hay cargas ni asignaciones registradas.</td></tr>'}</tbody></table></div>`;
  $('refAsig').onclick=()=>vistaAsignacionesGeneral();
}

async function vistaAvanceGeneral(){
  const d=await obtenerDatosGenerales();
  main.innerHTML=`<div class="section-head"><div><h2>Avance general</h2><p>Estado y resultados de cada carga por docente, grupo y materia.</p></div></div><div class="table-wrap"><table><thead><tr><th>Docente</th><th>Grupo</th><th>Tipo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>${d.cargas.map(r=>`<tr><td>${esc(d.docentes.find(x=>normEmail(x.correo)===normEmail(r.docente))?.nombre||r.docente)}</td><td>${esc(r.grupo)}</td><td>${esc(r.tipo||'')}</td><td>${esc(r.materia)}</td><td>${Number(r.alumnos)||0}</td><td>${Number(r.filas)||0}</td><td>${esc(r.estado||'CARGADO')}</td><td>${fecha(r.fecha)}</td></tr>`).join('')||'<tr><td colspan="8" class="empty">No hay avance registrado.</td></tr>'}</tbody></table></div>`;
}

async function vistaMisAsignaciones(){
  const d=await obtenerDatosGenerales();
  const rows=d.asignacionesVisibles.filter(r=>normEmail(r.docente)===normEmail(me.email));
  main.innerHTML=`<h2>Mis asignaciones</h2><p>Estas son las combinaciones de grupo y materia que tienes registradas. Las cargas antiguas también aparecen aunque su documento de asignación no exista.</p>${rows.length?`<div class="table-wrap"><table><thead><tr><th>Grupo</th><th>Tipo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Reporte</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.grupo)}</td><td>${esc(r.tipo||'')}</td><td>${esc(r.materia)}</td><td>${Number(r.alumnos)||0}</td><td>${Number(r.filas)||0}</td><td>${esc(r.estado||'CARGADO')}</td><td>${r.url?`<a href="${esc(r.url)}" target="_blank" rel="noopener">Abrir</a>`:'—'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Aún no tienes asignaciones ni cargas registradas.</div>'}`;
}
async function vistaMiAvance(){
  const d=await obtenerDatosGenerales();
  const rows=d.cargas.filter(r=>normEmail(r.docente)===normEmail(me.email));
  main.innerHTML=`<h2>Mi avance</h2><div class="table-wrap"><table><thead><tr><th>Grupo</th><th>Tipo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.grupo)}</td><td>${esc(r.tipo||'')}</td><td>${esc(r.materia)}</td><td>${Number(r.alumnos)||0}</td><td>${Number(r.filas)||0}</td><td>${esc(r.estado||'CARGADO')}</td><td>${fecha(r.fecha)}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">No hay cargas registradas.</td></tr>'}</tbody></table></div>`;
}
