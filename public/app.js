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

const TABS = {
  docentes: { n: 'Docentes', col: 'docentes', f: ['correo', 'nombre', 'matricula', 'rol'], key: 'correo', def: { rol: 'docente' }, types: { rol: ['docente', 'admin'] } },
  gruposES: { n: 'Grupos español', col: 'grupos', f: ['nombre'], fix: { tipo: 'Español' }, w: ['tipo', '==', 'Español'], key: 'nombre' },
  gruposEN: { n: 'Grupos inglés', col: 'grupos', f: ['nombre'], fix: { tipo: 'Ingles' }, w: ['tipo', '==', 'Ingles'], key: 'nombre' },
  asignaturas: { n: 'Asignaturas', col: 'asignaturas', f: ['nombre', 'tipo'], key: 'nombre', types: { tipo: ['Español', 'Ingles'] } },
  alumnos: { n: 'Alumnos', col: 'alumnos', f: ['correo', 'nombre', 'matricula', 'grupos'], key: 'correo' },
  asignaciones: { n: 'Asignaciones', col: 'asignaciones', f: ['docente', 'grupo', 'materia', 'tipo', 'url'], key: null },
  avance: { n: 'Avance', col: 'avance', f: ['docente', 'nombre', 'grupo', 'asignatura', 'filas', 'alumnos', 'url', 'estado'], key: null, def: { estado: 'Cargado' } }
};

$('in').onclick = () => { const p = new GoogleAuthProvider(); p.setCustomParameters({ hd: DOMINIO, prompt: 'select_account' }); signInWithPopup(auth, p).catch(e => $('err').textContent = e.message); };
$('out').onclick = () => signOut(auth);

onAuthStateChanged(auth, async u => {
  $('out').hidden = !u; $('nav').innerHTML = '';
  if (!u) { me = null; return; }
  const email = normEmail(u.email);
  if (!email.endsWith('@' + DOMINIO)) return bloqueo('Usa tu cuenta @' + DOMINIO);
  const admin = email === ADMIN_EMAIL.toLowerCase();
  let d;
  try { d = await getDoc(doc(db, 'docentes', email)); } catch (e) { return bloqueo('No se pudo consultar tu perfil: ' + e.message); }

  if (admin) {
    const perfil = { correo: email, nombre: u.displayName || 'Administrador IBIME', foto: u.photoURL || '', rol: 'admin', actualizado: serverTimestamp() };
    await setDoc(doc(db, 'docentes', email), perfil, { merge: true });
    me = { email, nombre: perfil.nombre, foto: perfil.foto, rol: 'admin' };
  } else {
    if (!d.exists()) {
      const perfil = { correo: email, nombre: u.displayName || email.split('@')[0], foto: u.photoURL || '', rol: 'docente', fechaAlta: serverTimestamp(), actualizado: serverTimestamp() };
      try { await setDoc(doc(db, 'docentes', email), perfil); d = await getDoc(doc(db, 'docentes', email)); }
      catch (e) { return bloqueo('No se pudo crear tu perfil de docente: ' + e.message); }
    }
    const data = d.data();
    if (data.rol !== 'docente') return bloqueo('Tu cuenta no tiene un rol de docente válido. Contacta al administrador.');
    me = { email, nombre: data.nombre || u.displayName || email, foto: data.foto || u.photoURL || '', rol: 'docente' };
  }
  menu(); ir('dashboard');
});

const bloqueo = m => { main.innerHTML = `<div id="login"><p class="msg">${esc(m)}</p></div>`; };
function menu() {
  const adminItems = Object.keys(TABS).map(k => [k, TABS[k].n]);
  const items = me.rol === 'admin'
    ? [['dashboard', 'Dashboard'], ['importar', 'Cargar reportes'], ...adminItems]
    : [['dashboard', 'Dashboard'], ['importar', 'Cargar reportes'], ['misAsignaciones', 'Mis asignaciones'], ['miAvance', 'Mi avance']];
  $('nav').innerHTML = items.map(([k, n]) => `<button data-k="${k}">${n}</button>`).join('');
  $('nav').onclick = e => e.target.dataset.k && ir(e.target.dataset.k);
}
function ir(k) {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  if (k === 'dashboard') return vistaDashboard();
  if (k === 'importar') return vistaImportar();
  if (k === 'misAsignaciones') return vistaMisAsignaciones();
  if (k === 'miAvance') return vistaMiAvance();
  return vistaTab(k);
}

function fecha(v) { if (!v) return ''; if (typeof v.toDate === 'function') return v.toDate().toLocaleString('es-MX'); return String(v); }
function options(list, value = '') { return list.map(x => `<option value="${esc(x)}" ${String(x) === String(value) ? 'selected' : ''}>${esc(x)}</option>`).join(''); }

async function getCatalog(col, filtro = null) {
  let q = collection(db, col); if (filtro) q = query(q, where(...filtro));
  return (await getDocs(q)).docs.map(d => ({ id: d.id, ...d.data() }));
}

async function vistaDashboard() {
  if (me.rol === 'admin') {
    const [docs, av, cal, alumnos, grupos, mats] = await Promise.all([
      getDocs(collection(db, 'docentes')), getDocs(collection(db, 'avance')), getDocs(collection(db, 'calificaciones')),
      getDocs(collection(db, 'alumnos')), getDocs(collection(db, 'grupos')), getDocs(collection(db, 'asignaturas'))
    ]);
    const docentes = docs.docs.map(x => x.data()).filter(x => x.rol === 'docente');
    const cargas = av.docs.map(x => x.data());
    main.innerHTML = `<h2>Dashboard del administrador</h2>
      <div class="cards"><div><b>${docentes.length}</b><span>Docentes</span></div><div><b>${grupos.size}</b><span>Grupos</span></div><div><b>${mats.size}</b><span>Asignaturas</span></div><div><b>${alumnos.size}</b><span>Alumnos</span></div><div><b>${cargas.length}</b><span>Cargas</span></div><div><b>${cal.size}</b><span>Calificaciones</span></div></div>
      <h3>Avance de docentes</h3>
      <table><tr><th>Docente</th><th>Correo</th><th>Cargas</th><th>Registros</th><th>Editar</th></tr>${docentes.map(d => { const mine = cargas.filter(a => a.docente === d.correo); return `<tr><td>${esc(d.nombre)}</td><td>${esc(d.correo)}</td><td>${mine.length}</td><td>${mine.reduce((s,a)=>s+(Number(a.filas)||0),0)}</td><td><button data-edit-doc="${esc(d.correo)}">Editar</button></td></tr>`; }).join('')}</table>`;
    main.querySelectorAll('[data-edit-doc]').forEach(b => b.onclick = () => editarDocente(b.dataset.editDoc));
    return;
  }
  const ds = (await getDocs(query(collection(db, 'avance'), where('docente', '==', me.email)))).docs.map(x => ({ id:x.id, ...x.data() }));
  const total = ds.reduce((s,a) => s + (Number(a.filas)||0), 0), alumnos = ds.reduce((s,a) => s + (Number(a.alumnos)||0), 0);
  main.innerHTML = `<div class="perfil">${me.foto ? `<img src="${esc(me.foto)}" alt="Foto">` : ''}<div><h2>Hola, ${esc(me.nombre)}</h2><p>${esc(me.email)} · Docente</p></div></div>
    <div class="cards"><div><b>${ds.length}</b><span>Cargas realizadas</span></div><div><b>${alumnos}</b><span>Alumnos detectados</span></div><div><b>${total}</b><span>Registros importados</span></div></div>
    <div class="acciones"><button class="p" id="nueva">+ Cargar nuevo reporte</button></div>
    <h3>Grupos y materias cargados</h3>${ds.length ? `<table><tr><th>Grupo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Fecha</th></tr>${ds.map(a => `<tr><td>${esc(a.grupo)}</td><td>${esc(a.asignatura)}</td><td>${Number(a.alumnos)||0}</td><td>${Number(a.filas)||0}</td><td>${esc(a.estado || 'Cargado')}</td><td>${fecha(a.fecha)}</td></tr>`).join('')}</table>` : '<div class="empty">Todavía no has cargado reportes.</div>'}`;
  $('nueva').onclick = () => ir('importar');
}

async function vistaImportar() {
  const [rows, gruposES, gruposEN, mats] = await Promise.all([
    getCatalog('asignaciones', ['docente','==',me.email]), getCatalog('grupos',['tipo','==','Español']), getCatalog('grupos',['tipo','==','Ingles']), getCatalog('asignaturas')
  ]);
  const grupos = [...gruposES.map(x => ({...x, tipo:'Español'})), ...gruposEN.map(x => ({...x, tipo:'Ingles'}))];
  main.innerHTML = `<h2>Cargar reportes de Classroom</h2><p>Selecciona grupo, materia y pega el enlace del reporte. Las filas anteriores quedan guardadas y pueden editarse.</p><div id="filas"></div>
    <button id="mas">+ Agregar fila</button> <button class="p" id="go">IMPORTAR REPORTES</button><pre id="log"></pre>`;
  const add = (g = '', m = '', u = '', tipo = '') => {
    const d = document.createElement('div'); d.className = 'fila carga-row';
    d.innerHTML = `<select class="tipo"><option value="">Tipo</option><option value="Español" ${tipo==='Español'?'selected':''}>Español</option><option value="Ingles" ${tipo==='Ingles'?'selected':''}>Inglés</option></select>
      <select class="g"><option value="">Grupo</option></select><select class="m"><option value="">Materia</option>${options(mats.map(x=>x.nombre),m)}</select>
      <input class="u" placeholder="Pegar enlace de Google Sheets" value="${esc(u)}"><button class="danger quitar">Quitar</button>`;
    $('filas').append(d); const sync = () => { const tg = d.querySelector('.tipo').value; const gs = grupos.filter(x => x.tipo === tg).map(x => x.nombre); d.querySelector('.g').innerHTML = `<option value="">Grupo</option>${options(gs,g)}`; };
    d.querySelector('.tipo').onchange = sync; d.querySelector('.quitar').onclick = () => d.remove(); sync();
  };
  rows.forEach(r => add(r.grupo, r.materia, r.url || '', r.tipo || (gruposES.some(x=>x.nombre===r.grupo)?'Español':'Ingles'))); if (!rows.length) add();
  $('mas').onclick = () => add(); $('go').onclick = importar;
}

async function leer(url) {
  const r = await fetch(BRIDGE_URL, { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({idToken:await auth.currentUser.getIdToken(),url}) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error); return j.datos;
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
  const vistos=new Set(),items=[];
  document.querySelectorAll('.carga-row').forEach(d=>{const it={tipo:d.querySelector('.tipo').value,grupo:d.querySelector('.g').value.trim(),materia:d.querySelector('.m').value.trim(),url:d.querySelector('.u').value.trim()};if(it.grupo&&it.materia&&it.url&&!vistos.has(it.url)){vistos.add(it.url);items.push(it);}});
  if(!items.length){log('No hay filas completas. Selecciona tipo, grupo, materia y enlace.');$('go').disabled=false;return;}
  log(`Leyendo ${items.length} archivo(s)...`);
  const res=await Promise.all(items.map(async it=>{try{return{it,parsed:parsear(await leer(it.url),it)}}catch(e){return{it,err:e.message}}}));
  let total=0;
  for(const r of res){
    if(r.err){log(`❌ ${r.it.grupo}: ${r.err}`);continue;}
    const {rows,alumnos}=r.parsed;
    for(let i=0;i<rows.length;i+=450){const b=writeBatch(db);rows.slice(i,i+450).forEach(x=>b.set(doc(db,'calificaciones',hash([x.grupo,x.asignatura,x.correo,x.actividad,x.fecha].join('|'))),x,{merge:true}));await b.commit();}
    for(const a of alumnos){await setDoc(doc(db,'alumnos',a.correo),{correo:a.correo,nombre:a.nombre,grupos:arrayUnion(a.grupo),ultimoDocente:me.email,actualizado:serverTimestamp()},{merge:true});}
    const aid=hash([me.email,r.it.grupo,r.it.materia].join('|'));
    await setDoc(doc(db,'asignaciones',aid),{docente:me.email,nombre:me.nombre,grupo:r.it.grupo,materia:r.it.materia,tipo:r.it.tipo||'Classroom',url:r.it.url,actualizado:serverTimestamp()},{merge:true});
    await setDoc(doc(db,'avance',aid),{docente:me.email,nombre:me.nombre,grupo:r.it.grupo,asignatura:r.it.materia,filas:rows.length,alumnos:alumnos.length,url:r.it.url,estado:'Cargado',fecha:serverTimestamp()},{merge:true});
    total+=rows.length; log(`✅ ${r.it.grupo} · ${r.it.materia}: ${rows.length} registros · ${alumnos.length} alumnos`);
  }
  log(`Listo, ${me.nombre||me.email}. ${total} registros guardados.`);$('go').disabled=false;
}

async function guardar(t, objs){
  for(let i=0;i<objs.length;i+=450){
    const b=writeBatch(db);
    objs.slice(i,i+450).forEach(raw=>{
      let o={...t.def,...raw,...t.fix};
      const existingId=o._id; delete o._id;
      if(o.correo)o.correo=normEmail(o.correo); if(o.docente)o.docente=normEmail(o.docente);
      const id=existingId || (t.key ? String(o[t.key]||'').toLowerCase().trim() : hash(t.f.map(f=>o[f]??'').join('|')+(t.fix?.tipo??'')));
      if(!id)return; if(t.key)o[t.key]=String(o[t.key]||'').toLowerCase().trim();
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
    if(f==='estado') return `<label>${f}<select id="n_${f}">${options(['Cargado','Pendiente','Revisar','Corregido'],v||'Cargado')}</select></label>`;
    return `<label>${f}<input id="n_${f}" value="${esc(v)}" placeholder="${f}" ${data.id && t.key === f ? 'readonly' : ''}></label>`;
  }).join('');
}

async function vistaTab(k){
  const t=TABS[k]; let q=collection(db,t.col); if(t.w)q=query(q,where(...t.w)); const ds=(await getDocs(q)).docs;
  const rows=ds.map(d=>({id:d.id,...d.data()}));
  main.innerHTML=`<div class="section-head"><div><h2>${t.n}</h2><p>Agrega, edita y completa la información. Los cambios se guardan en Firestore.</p></div><button class="p" id="nuevo">+ Nuevo</button></div>
    <div id="editor" class="editor" hidden></div>
    <div class="tools"><input id="buscar" placeholder="Buscar..."><button id="recargar">Actualizar</button></div>
    <div class="table-wrap"><table><tr>${t.f.map(f=>`<th>${f}</th>`).join('')}<th>Acciones</th></tr>${rows.map(r=>`<tr>${t.f.map(f=>`<td>${esc(Array.isArray(r[f])?r[f].join(', '):r[f])}</td>`).join('')}<td class="actions"><button data-edit="${esc(r.id)}">Editar</button><button class="danger" data-del="${esc(r.id)}">Borrar</button></td></tr>`).join('')}</table></div>`;
  const editor=$('editor');
  const openEditor=(data={})=>{editor.hidden=false;editor.innerHTML=`<h3>${data.id?'Editar':'Nueva'} ${t.n}</h3><div class="form-grid">${formFields(t,data)}</div><div class="actions"><button class="p" id="guardarForm">Guardar</button><button id="cancelarForm">Cancelar</button></div>`;
    $('cancelarForm').onclick=()=>{editor.hidden=true}; $('guardarForm').onclick=async()=>{const o={_id:data.id||''};t.f.forEach(f=>{let v=$('n_'+f)?.value.trim()||'';if(f==='correo'||f==='docente')v=normEmail(v);if(f==='grupos')v=v.split(',').map(x=>x.trim()).filter(Boolean);o[f]=v;});if(t.fix)Object.assign(o,t.fix);if(k==='docentes'&&o.correo===ADMIN_EMAIL.toLowerCase())o.rol='admin';if(!o[t.key||t.f[0]]&&!t.key)return alert('Completa los campos obligatorios.');await guardar(t,[o]);editor.hidden=true;vistaTab(k);};
  };
  $('nuevo').onclick=()=>openEditor();
  main.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEditor(rows.find(r=>r.id===b.dataset.edit)));
  main.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('¿Borrar este registro?'))return;await deleteDoc(doc(db,t.col,b.dataset.del));vistaTab(k);});
  $('recargar').onclick=()=>vistaTab(k);
  $('buscar').oninput=e=>{const term=e.target.value.toLowerCase();main.querySelectorAll('table tr').forEach((tr,i)=>{if(i===0)return;tr.hidden=!tr.textContent.toLowerCase().includes(term);});};
}

async function editarDocente(correo){ const d=await getDoc(doc(db,'docentes',correo)); if(d.exists()){ vistaTab('docentes'); setTimeout(()=>document.querySelector(`[data-edit="${CSS.escape(correo)}"]`)?.click(),0); } }

async function vistaMisAsignaciones(){
  const rows=await getCatalog('asignaciones',['docente','==',me.email]);
  main.innerHTML=`<h2>Mis asignaciones</h2><p>Estas son las combinaciones de grupo y materia que tienes registradas.</p>${rows.length?`<table><tr><th>Grupo</th><th>Materia</th><th>Tipo</th><th>Enlace</th></tr>${rows.map(r=>`<tr><td>${esc(r.grupo)}</td><td>${esc(r.materia)}</td><td>${esc(r.tipo)}</td><td><a href="${esc(r.url)}" target="_blank" rel="noopener">Abrir</a></td></tr>`).join('')}</table>`:'<div class="empty">Aún no tienes asignaciones.</div>'}`;
}
async function vistaMiAvance(){
  const rows=await getCatalog('avance',['docente','==',me.email]);
  main.innerHTML=`<h2>Mi avance</h2><table><tr><th>Grupo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Fecha</th></tr>${rows.map(r=>`<tr><td>${esc(r.grupo)}</td><td>${esc(r.asignatura)}</td><td>${r.alumnos||0}</td><td>${r.filas||0}</td><td>${esc(r.estado||'Cargado')}</td><td>${fecha(r.fecha)}</td></tr>`).join('')}</table>`;
}
