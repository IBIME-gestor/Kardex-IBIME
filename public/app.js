import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where, writeBatch, serverTimestamp, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { CONFIG, BRIDGE_URL, ADMIN_EMAIL, DOMINIO } from './config.js';

const app = initializeApp(CONFIG), auth = getAuth(app), db = getFirestore(app);
const $ = id => document.getElementById(id), main = $('main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = s => { let a = 0xdeadbeef, b = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); } a = Math.imul(a ^ a >>> 16, 2246822507) ^ Math.imul(b ^ b >>> 13, 3266489909); b = Math.imul(b ^ b >>> 16, 2246822507) ^ Math.imul(a ^ a >>> 13, 3266489909); return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36); };
let me = null;

const TABS = {
  docentes: { n: 'Docentes', col: 'docentes', f: ['correo', 'nombre', 'matricula', 'rol'], key: 'correo', def: { rol: 'docente' } },
  gruposES: { n: 'Grupos español', col: 'grupos', f: ['nombre'], fix: { tipo: 'Español' }, w: ['tipo', '==', 'Español'] },
  gruposEN: { n: 'Grupos inglés', col: 'grupos', f: ['nombre'], fix: { tipo: 'Ingles' }, w: ['tipo', '==', 'Ingles'] },
  asignaturas: { n: 'Asignaturas', col: 'asignaturas', f: ['nombre', 'tipo'] },
  alumnos: { n: 'Alumnos', col: 'alumnos', f: ['nombre', 'correo', 'grupo'] },
  asignaciones: { n: 'Asignaciones', col: 'asignaciones', f: ['docente', 'grupo', 'materia', 'tipo', 'url'], key: null },
  avance: { n: 'Avance', col: 'avance', ro: true, f: ['nombre', 'grupo', 'asignatura', 'filas', 'alumnos', 'fecha'] },
};

$('in').onclick = () => { const p = new GoogleAuthProvider(); p.setCustomParameters({ hd: DOMINIO, prompt: 'select_account' }); signInWithPopup(auth, p).catch(e => $('err').textContent = e.message); };
$('out').onclick = () => signOut(auth);

onAuthStateChanged(auth, async u => {
  $('out').hidden = !u; $('nav').innerHTML = '';
  if (!u) { me = null; return; }
  const email = String(u.email || '').toLowerCase();
  if (!email.endsWith('@' + DOMINIO)) return bloqueo('Usa tu cuenta @' + DOMINIO);

  const admin = email === ADMIN_EMAIL.toLowerCase();
  let d = null;
  try { d = await getDoc(doc(db, 'docentes', email)); } catch (e) { return bloqueo('No se pudo consultar tu perfil: ' + e.message); }

  // El administrador queda reconocido por correo incluso en su primer acceso.
  if (admin) {
    const perfil = {
      correo: email,
      nombre: u.displayName || 'Administrador IBIME',
      foto: u.photoURL || '',
      rol: 'admin',
      actualizado: serverTimestamp()
    };
    await setDoc(doc(db, 'docentes', email), perfil, { merge: true });
    me = { email, nombre: perfil.nombre, foto: perfil.foto, rol: 'admin' };
  } else {
    // Primer acceso de cualquier cuenta institucional: alta automática como docente.
    if (!d.exists()) {
      const perfil = {
        correo: email,
        nombre: u.displayName || email.split('@')[0],
        foto: u.photoURL || '',
        rol: 'docente',
        fechaAlta: serverTimestamp(),
        actualizado: serverTimestamp()
      };
      try {
        await setDoc(doc(db, 'docentes', email), perfil);
        d = await getDoc(doc(db, 'docentes', email));
      } catch (e) { return bloqueo('No se pudo crear tu perfil de docente: ' + e.message); }
    }
    const data = d.data();
    if (data.rol !== 'docente') return bloqueo('Tu cuenta no tiene un rol de docente válido. Contacta al administrador.');
    me = { email, nombre: data.nombre || u.displayName || email, foto: data.foto || u.photoURL || '', rol: 'docente' };
  }

  menu(); ir('dashboard');
});

const bloqueo = m => { main.innerHTML = `<div id="login"><p class="msg">${esc(m)}</p></div>`; };
function menu() {
  const items = [['dashboard', 'Dashboard'], ['importar', 'Cargar reportes'], ...(me.rol === 'admin' ? Object.keys(TABS).map(k => [k, TABS[k].n]) : [])];
  $('nav').innerHTML = items.map(([k, n]) => `<button data-k="${k}">${n}</button>`).join('');
  $('nav').onclick = e => e.target.dataset.k && ir(e.target.dataset.k);
}
function ir(k) { document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.k === k)); if (k === 'dashboard') return vistaDashboard(); if (k === 'importar') return vistaImportar(); vistaTab(k); }

async function vistaDashboard() {
  if (me.rol === 'admin') {
    const [docs, av, cal] = await Promise.all([
      getDocs(collection(db, 'docentes')),
      getDocs(collection(db, 'avance')),
      getDocs(collection(db, 'calificaciones'))
    ]);
    const docentes = docs.docs.map(x => x.data()).filter(x => x.rol === 'docente');
    const cargas = av.docs.map(x => x.data());
    main.innerHTML = `<h2>Dashboard del administrador</h2>
      <div class="cards"><div><b>${docentes.length}</b><span>Docentes</span></div><div><b>${cargas.length}</b><span>Cargas registradas</span></div><div><b>${cal.size}</b><span>Calificaciones</span></div></div>
      <h3>Docentes y cargas</h3>
      <table><tr><th>Docente</th><th>Correo</th><th>Cargas</th><th>Registros</th></tr>${docentes.map(d => { const mine = cargas.filter(a => a.docente === d.correo); return `<tr><td>${esc(d.nombre)}</td><td>${esc(d.correo)}</td><td>${mine.length}</td><td>${mine.reduce((s,a)=>s+(Number(a.filas)||0),0)}</td></tr>`; }).join('')}</table>`;
    return;
  }
  const ds = (await getDocs(query(collection(db, 'avance'), where('docente', '==', me.email)))).docs.map(x => ({ id:x.id, ...x.data() }));
  const total = ds.reduce((s,a) => s + (Number(a.filas)||0), 0);
  const alumnos = ds.reduce((s,a) => s + (Number(a.alumnos)||0), 0);
  main.innerHTML = `<div class="perfil">${me.foto ? `<img src="${esc(me.foto)}" alt="Foto">` : ''}<div><h2>Hola, ${esc(me.nombre)}</h2><p>${esc(me.email)} · Docente</p></div></div>
    <div class="cards"><div><b>${ds.length}</b><span>Cargas realizadas</span></div><div><b>${alumnos}</b><span>Alumnos detectados</span></div><div><b>${total}</b><span>Registros importados</span></div></div>
    <div class="acciones"><button class="p" id="nueva">+ Cargar nuevo reporte</button></div>
    <h3>Grupos y materias cargados</h3>
    ${ds.length ? `<table><tr><th>Grupo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Fecha</th></tr>${ds.map(a => `<tr><td>${esc(a.grupo)}</td><td>${esc(a.asignatura)}</td><td>${Number(a.alumnos)||0}</td><td>${Number(a.filas)||0}</td><td>${fecha(a.fecha)}</td></tr>`).join('')}</table>` : '<div class="empty">Todavía no has cargado reportes.</div>'}`;
  $('nueva').onclick = () => ir('importar');
}
function fecha(v) { if (!v) return ''; if (typeof v.toDate === 'function') return v.toDate().toLocaleString('es-MX'); return String(v); }

async function vistaImportar() {
  const rows = (await getDocs(query(collection(db, 'asignaciones'), where('docente', '==', me.email)))).docs.map(d => d.data());
  main.innerHTML = `<h2>Cargar reportes de Classroom</h2><p>Selecciona grupo y materia y pega el enlace del reporte de Google Sheets. Puedes agregar varias cargas antes de importar.</p><div id="filas"></div>
    <button id="mas">+ Agregar fila</button> <button class="p" id="go">IMPORTAR REPORTES</button><pre id="log"></pre>`;
  const add = (g = '', m = '', u = '') => { const d = document.createElement('div'); d.className = 'fila'; d.innerHTML = `<input class="g" placeholder="Grupo" value="${esc(g)}"><input class="m" placeholder="Materia" value="${esc(m)}"><input class="u" placeholder="Pegar enlace de Google Sheets" value="${esc(u)}">`; $('filas').append(d); };
  rows.forEach(r => add(r.grupo, r.materia, r.url || '')); if (!rows.length) add();
  $('mas').onclick = () => add(); $('go').onclick = importar;
}

async function leer(url) {
  const r = await fetch(BRIDGE_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ idToken: await auth.currentUser.getIdToken(), url }) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error); return j.datos;
}

function parsear(d, it) {
  const [fechas = [], acts = []] = [d[0] || [], d[1] || []], out = [], alumnos = new Set();
  for (let i = 2; i < d.length; i++) {
    const f = d[i] || [], s = f.join(' ').toLowerCase();
    if (s.includes('media de la clase') || s.includes('abrir classroom')) continue;
    const ie = f.findIndex(c => String(c).includes('@')); if (ie < 0) continue;
    const correo = String(f[ie]).trim().toLowerCase(); if (!correo) continue; alumnos.add(correo);
    const alumno = f.slice(0, ie).filter(c => c && String(c).trim()).join(' ').trim() || 'Alumno';
    for (let c = ie + 1; c < f.length; c++) {
      const fecha = String(fechas[c] ?? '').trim(), act = String(acts[c] ?? '').trim(); if (!fecha && !act) continue;
      let n = parseFloat(String(f[c]).replace(',', '.')); if (isNaN(n)) n = 0; if (n > 10) n = Math.min(n / 10, 10);
      out.push({ docente: me.email, profesor: me.nombre, grupo: it.grupo, alumno, correo, fecha, actividad: act, calif: n, asignatura: it.materia });
    }
  }
  return { rows: out, alumnos: alumnos.size };
}

async function importar() {
  const log = m => $('log').textContent += m + '\n'; $('log').textContent = ''; $('go').disabled = true;
  const vistos = new Set(), items = [];
  document.querySelectorAll('.fila').forEach(d => { const it = { grupo: d.querySelector('.g').value.trim(), materia: d.querySelector('.m').value.trim(), url: d.querySelector('.u').value.trim() }; if (it.grupo && it.materia && it.url && !vistos.has(it.url)) { vistos.add(it.url); items.push(it); } });
  if (!items.length) { log('No hay filas completas (grupo, materia y link).'); $('go').disabled = false; return; }
  log(`Leyendo ${items.length} archivo(s)...`);
  const res = await Promise.all(items.map(async it => { try { return { it, parsed: parsear(await leer(it.url), it) }; } catch (e) { return { it, err: e.message }; } }));
  let total = 0;
  for (const r of res) {
    if (r.err) { log(`❌ ${r.it.grupo}: ${r.err}`); continue; }
    const { rows, alumnos } = r.parsed;
    for (let i = 0; i < rows.length; i += 450) { const b = writeBatch(db); rows.slice(i, i + 450).forEach(x => b.set(doc(db, 'calificaciones', hash([x.docente, x.grupo, x.asignatura, x.correo, x.actividad, x.fecha].join('|'))), x)); await b.commit(); }
    const aid = hash([me.email, r.it.grupo, r.it.materia, r.it.url].join('|'));
    await setDoc(doc(db, 'asignaciones', aid), { docente: me.email, nombre: me.nombre, grupo: r.it.grupo, materia: r.it.materia, tipo: 'Classroom', url: r.it.url, actualizado: serverTimestamp() }, { merge: true });
    await setDoc(doc(db, 'avance', hash(me.email + r.it.grupo + r.it.materia)), { docente: me.email, nombre: me.nombre, grupo: r.it.grupo, asignatura: r.it.materia, filas: rows.length, alumnos, url: r.it.url, fecha: serverTimestamp() });
    total += rows.length; log(`✅ ${r.it.grupo} · ${r.it.materia}: ${rows.length} registros · ${alumnos} alumnos`);
  }
  log(`Listo, ${me.nombre || me.email}. ${total} registros guardados.`); $('go').disabled = false;
}

async function guardar(t, objs) {
  for (let i = 0; i < objs.length; i += 450) { const b = writeBatch(db); objs.slice(i, i + 450).forEach(o => { o = { ...t.def, ...o, ...t.fix }; const id = t.key ? String(o[t.key]).toLowerCase().trim() : hash(t.f.map(f => o[f] ?? '').join('|') + (t.fix?.tipo ?? '')); if (t.key) o[t.key] = id; b.set(doc(db, t.col, id), o, { merge: true }); }); await b.commit(); }
}
async function vistaTab(k) {
  const t = TABS[k]; let q = collection(db, t.col); if (t.w) q = query(q, where(...t.w)); const ds = (await getDocs(q)).docs;
  main.innerHTML = `<h2>${t.n}</h2>` + (t.ro ? '' : `<div class="fila">${t.f.map(f => `<input id="n_${f}" placeholder="${f}">`).join('')}<button class="p" id="add">Agregar / actualizar</button></div><p>Importar Excel o CSV con columnas: <b>${t.f.join(', ')}</b> <input type="file" id="xl" accept=".xlsx,.xls,.csv"></p>`) + `<table><tr>${t.f.map(f => `<th>${f}</th>`).join('')}${t.ro ? '' : '<th></th>'}</tr>${ds.map(d => `<tr>${t.f.map(f => `<td>${esc(d.data()[f])}</td>`).join('')}${t.ro ? '' : `<td><button data-d="${d.id}">Borrar</button></td>`}</tr>`).join('')}</table>`;
  if (t.ro) return;
  $('add').onclick = async () => { const o = {}; t.f.forEach(f => o[f] = $('n_' + f).value.trim()); if (!o[t.key || t.f[0]]) return; await guardar(t, [o]); vistaTab(k); };
  $('xl').onchange = async e => { const wb = XLSX.read(await e.target.files[0].arrayBuffer()); const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }); const objs = rows.map(r => { const o = {}; Object.keys(r).forEach(h => { const f = h.toLowerCase().trim(); if (t.f.includes(f)) o[f] = String(r[h]).trim(); }); return o; }).filter(o => o[t.key || t.f[0]]); await guardar(t, objs); vistaTab(k); };
  main.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => { await deleteDoc(doc(db, t.col, b.dataset.d)); vistaTab(k); });
}
