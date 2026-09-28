import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where, writeBatch, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { CONFIG, BRIDGE_URL, ADMIN_EMAIL, DOMINIO } from './config.js';

const app = initializeApp(CONFIG), auth = getAuth(app), db = getFirestore(app);
const $ = id => document.getElementById(id), main = $('main');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hash = s => { let a = 0xdeadbeef, b = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
  a = Math.imul(a ^ a >>> 16, 2246822507) ^ Math.imul(b ^ b >>> 13, 3266489909); b = Math.imul(b ^ b >>> 16, 2246822507) ^ Math.imul(a ^ a >>> 13, 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36); };
let me = null;

const TABS = {
  docentes: { n: 'Docentes', col: 'docentes', f: ['correo', 'nombre', 'matricula', 'rol'], key: 'correo', def: { rol: 'docente' } },
  gruposES: { n: 'Grupos español', col: 'grupos', f: ['nombre'], fix: { tipo: 'Español' }, w: ['tipo', '==', 'Español'] },
  gruposEN: { n: 'Grupos inglés', col: 'grupos', f: ['nombre'], fix: { tipo: 'Ingles' }, w: ['tipo', '==', 'Ingles'] },
  asignaturas: { n: 'Asignaturas', col: 'asignaturas', f: ['nombre', 'tipo'] },
  alumnos: { n: 'Alumnos', col: 'alumnos', f: ['nombre', 'correo', 'grupo'] },
  asignaciones: { n: 'Asignaciones', col: 'asignaciones', f: ['docente', 'grupo', 'materia', 'tipo'] },
  avance: { n: 'Avance', col: 'avance', ro: true, f: ['nombre', 'grupo', 'asignatura', 'filas'] },
};

// ---------- sesión ----------
$('in').onclick = () => { const p = new GoogleAuthProvider(); p.setCustomParameters({ hd: DOMINIO }); signInWithPopup(auth, p).catch(e => $('err').textContent = e.message); };
$('out').onclick = () => signOut(auth);
onAuthStateChanged(auth, async u => {
  $('out').hidden = !u; $('nav').innerHTML = '';
  if (!u) return;
  const email = u.email.toLowerCase(), admin = email === ADMIN_EMAIL;
  if (!email.endsWith('@' + DOMINIO)) return bloqueo('Usa tu cuenta @' + DOMINIO);
  let d = null; try { d = await getDoc(doc(db, 'docentes', email)); } catch (e) {}
  if (!admin && !(d && d.exists())) return bloqueo('Tu cuenta aún no tiene acceso. Pide al administrador que te agregue.');
  me = { email, nombre: d?.exists() ? d.data().nombre : u.displayName, rol: admin ? 'admin' : d.data().rol };
  menu(); ir('importar');
});
const bloqueo = m => { main.innerHTML = `<div id="login"><p class="msg">${esc(m)}</p></div>`; };
function menu() {
  const items = [['importar', 'Importar'], ...(me.rol === 'admin' ? Object.keys(TABS).map(k => [k, TABS[k].n]) : [])];
  $('nav').innerHTML = items.map(([k, n]) => `<button data-k="${k}">${n}</button>`).join('');
  $('nav').onclick = e => e.target.dataset.k && ir(e.target.dataset.k);
}
function ir(k) { document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.k === k)); k === 'importar' ? vistaImportar() : vistaTab(k); }

// ---------- importar por URL ----------
async function vistaImportar() {
  const rows = (await getDocs(query(collection(db, 'asignaciones'), where('docente', '==', me.email)))).docs.map(d => d.data());
  main.innerHTML = `<h2>Importar calificaciones</h2><div id="filas"></div>
    <button id="mas">+ Fila</button> <button class="p" id="go">IMPORTAR</button><pre id="log"></pre>`;
  const add = (g = '', m = '') => { const d = document.createElement('div'); d.className = 'fila';
    d.innerHTML = `<input class="g" placeholder="Grupo" value="${esc(g)}"><input class="m" placeholder="Asignatura" value="${esc(m)}"><input class="u" placeholder="Pegar link de Sheets">`;
    $('filas').append(d); };
  rows.forEach(r => add(r.grupo, r.materia)); if (!rows.length) add();
  $('mas').onclick = () => add(); $('go').onclick = importar;
}

async function leer(url) {
  const r = await fetch(BRIDGE_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ idToken: await auth.currentUser.getIdToken(), url }) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error); return j.datos;
}

function parsear(d, it) {
  const [fechas, acts] = [d[0], d[1]], out = [];
  for (let i = 2; i < d.length; i++) {
    const f = d[i], s = f.join(' ').toLowerCase();
    if (s.includes('media de la clase') || s.includes('abrir classroom')) continue;
    const ie = f.findIndex(c => String(c).includes('@')); if (ie < 0) continue;
    const correo = String(f[ie]).trim().toLowerCase();
    const alumno = f.slice(0, ie).filter(c => c && String(c).trim()).join(' ').trim() || 'Alumno';
    for (let c = ie + 1; c < f.length; c++) {
      const fecha = String(fechas[c] ?? '').trim(), act = String(acts[c] ?? '').trim();
      if (!fecha && !act) continue;
      let n = parseFloat(String(f[c]).replace(',', '.')); if (isNaN(n)) n = 0; if (n > 10) n = Math.min(n / 10, 10);
      out.push({ docente: me.email, profesor: me.nombre, grupo: it.grupo, alumno, correo, fecha, actividad: act, calif: n, asignatura: it.materia });
    }
  }
  return out;
}

async function importar() {
  const log = m => $('log').textContent += m + '\n'; $('log').textContent = ''; $('go').disabled = true;
  const vistos = new Set(), items = [];
  document.querySelectorAll('.fila').forEach(d => { const it = { grupo: d.querySelector('.g').value.trim(), materia: d.querySelector('.m').value.trim(), url: d.querySelector('.u').value.trim() };
    if (it.grupo && it.materia && it.url && !vistos.has(it.url)) { vistos.add(it.url); items.push(it); } });
  if (!items.length) { log('No hay filas completas (grupo, asignatura y link).'); $('go').disabled = false; return; }
  log(`Leyendo ${items.length} archivo(s)...`);
  const res = await Promise.all(items.map(async it => { try { return { it, rows: parsear(await leer(it.url), it) }; } catch (e) { return { it, err: e.message }; } }));
  let total = 0;
  for (const r of res) {
    if (r.err) { log(`❌ ${r.it.grupo}: ${r.err}`); continue; }
    for (let i = 0; i < r.rows.length; i += 450) {
      const b = writeBatch(db);
      r.rows.slice(i, i + 450).forEach(x => b.set(doc(db, 'calificaciones', hash([x.docente, x.grupo, x.asignatura, x.correo, x.actividad, x.fecha].join('|'))), x));
      await b.commit();
    }
    await setDoc(doc(db, 'avance', hash(me.email + r.it.grupo + r.it.materia)), { docente: me.email, nombre: me.nombre, grupo: r.it.grupo, asignatura: r.it.materia, filas: r.rows.length, fecha: serverTimestamp() });
    total += r.rows.length; log(`✅ ${r.it.grupo} · ${r.it.materia}: ${r.rows.length} registros`);
  }
  log(`Listo, ${me.nombre || me.email}. ${total} registros guardados (reimportar actualiza, no duplica).`); $('go').disabled = false;
}

// ---------- catálogos del admin ----------
async function guardar(t, objs) {
  for (let i = 0; i < objs.length; i += 450) {
    const b = writeBatch(db);
    objs.slice(i, i + 450).forEach(o => { o = { ...t.def, ...o, ...t.fix };
      const id = t.key ? String(o[t.key]).toLowerCase().trim() : hash(t.f.map(f => o[f] ?? '').join('|') + (t.fix?.tipo ?? ''));
      if (t.key) o[t.key] = id; b.set(doc(db, t.col, id), o, { merge: true }); });
    await b.commit();
  }
}
async function vistaTab(k) {
  const t = TABS[k]; let q = collection(db, t.col); if (t.w) q = query(q, where(...t.w));
  const ds = (await getDocs(q)).docs;
  main.innerHTML = `<h2>${t.n}</h2>` + (t.ro ? '' : `<div class="fila">${t.f.map(f => `<input id="n_${f}" placeholder="${f}">`).join('')}<button class="p" id="add">Agregar / actualizar</button></div>
    <p>Importar Excel o CSV con columnas: <b>${t.f.join(', ')}</b> <input type="file" id="xl" accept=".xlsx,.xls,.csv"></p>`) +
    `<table><tr>${t.f.map(f => `<th>${f}</th>`).join('')}${t.ro ? '' : '<th></th>'}</tr>${ds.map(d => `<tr>${t.f.map(f => `<td>${esc(d.data()[f])}</td>`).join('')}${t.ro ? '' : `<td><button data-d="${d.id}">Borrar</button></td>`}</tr>`).join('')}</table>`;
  if (t.ro) return;
  $('add').onclick = async () => { const o = {}; t.f.forEach(f => o[f] = $('n_' + f).value.trim());
    if (!o[t.key || t.f[0]]) return; await guardar(t, [o]); vistaTab(k); };
  $('xl').onchange = async e => { const wb = XLSX.read(await e.target.files[0].arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    const objs = rows.map(r => { const o = {}; Object.keys(r).forEach(h => { const f = h.toLowerCase().trim(); if (t.f.includes(f)) o[f] = String(r[h]).trim(); }); return o; }).filter(o => o[t.key || t.f[0]]);
    await guardar(t, objs); vistaTab(k); };
  main.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => { await deleteDoc(doc(db, t.col, b.dataset.d)); vistaTab(k); });
}
