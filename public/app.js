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
      if (!['docente', 'admin'].includes(rol)) {
        return bloqueo('Tu cuenta no tiene un rol de docente válido. Contacta al administrador.');
      }
      me = {
        email,
        nombre: data.nombre || u.displayName || email,
        foto: data.foto || u.photoURL || '',
        rol
      };
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
  const adminItems = Object.keys(TABS).map(k => [k, TABS[k].n]);
  const items = me.rol === 'admin'
    ? [['dashboard', 'Dashboard'], ['importar', 'Cargar reportes'], ...adminItems]
    : [['dashboard', 'Dashboard'], ['importar', 'Cargar reportes'], ['misAsignaciones', 'Mis asignaciones'], ['miAvance', 'Mi avance']];
  $('nav').innerHTML = items.map(([k, n]) => `<button data-k="${k}">${n}</button>`).join('');
  $('nav').onclick = e => e.target.dataset.k && ir(e.target.dataset.k);
}
function ir(k) {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  const action = k === 'dashboard' ? vistaDashboard
    : k === 'importar' ? vistaImportar
    : k === 'misAsignaciones' ? vistaMisAsignaciones
    : k === 'miAvance' ? vistaMiAvance
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
    <h3>Grupos y materias cargados</h3>${ds.length ? `<table><tr><th>Grupo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Fecha</th></tr>${ds.map(a => `<tr><td>${esc(a.grupo)}</td><td>${esc(a.asignatura)}</td><td>${Number(a.alumnos)||0}</td><td>${Number(a.filas)||0}</td><td>${esc(a.estado || 'CARGADO')}</td><td>${fecha(a.fecha)}</td></tr>`).join('')}</table>` : '<div class="empty">Todavía no has cargado reportes.</div>'}`;
  $('nueva').onclick = () => ir('importar');
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
  const res=await Promise.all(items.map(async it=>{try{return{it,parsed:parsear(await leer(it.url),it)}}catch(e){return{it,err:e.message}}}));
  let total=0;
  for(const r of res){
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
      for(const a of alumnos){
        await setDoc(doc(db,'alumnos',a.correo),normalizarGuardado({correo:a.correo,nombre:a.nombre,grupos:arrayUnion(String(a.grupo||'').trim().replace(/\s+/g,' ').toUpperCase()),ultimoDocente:me.email,actualizado:serverTimestamp()}),{merge:true});
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
      const id=existingId || (t.key ? String(o[t.key]||'').toLowerCase().trim() : hash(t.f.map(f=>o[f]??'').join('|')+(t.fix?.tipo??'')));
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
  const protectedFields = new Set(['correo', 'docente', 'rol', 'url', 'foto']);
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

async function vistaTab(k){
  const t=TABS[k]; let q=collection(db,t.col); if(t.w && !['gruposES','gruposEN'].includes(k))q=query(q,where(...t.w)); const ds=(await getDocs(q)).docs;
  let rows=ds.map(d=>({id:d.id,...d.data()}));
  if(k==='gruposES') rows=rows.filter(r=>String(r.tipo||'').toUpperCase()==='ESPAÑOL');
  if(k==='gruposEN') rows=rows.filter(r=>String(r.tipo||'').toUpperCase()==='INGLES');
  const bulk = esCargaMasiva(k);
  const alumnoBulk = k === 'alumnos';
  main.innerHTML=`<div class="section-head"><div><h2>${t.n}</h2><p>${bulk ? (alumnoBulk ? 'Carga tu Excel o descarga la plantilla oficial. Revisa todos los alumnos antes de guardarlos.' : 'Agrega una por una o pega directamente varias filas copiadas de Google Sheets. Revisa todo antes de guardar.') : 'Agrega, edita y completa la información. Los cambios se guardan en Firestore.'}</p></div><div class="actions"><button class="p" id="nuevo">+ Nuevo</button>${alumnoBulk ? '<button id="plantillaAlumnos">DESCARGAR PLANTILLA EXCEL</button><label class="button-file" for="excelAlumnos">SUBIR EXCEL</label><input id="excelAlumnos" type="file" accept=".xlsx,.xls" hidden>' : bulk ? '<button id="pegarMasivo">Pegar desde Sheets</button>' : ''}</div></div>
    ${bulk ? `<div id="bulkPaste" class="bulk-paste" hidden><label>${alumnoBulk ? 'También puedes pegar las 6 columnas desde Excel/Sheets' : 'Pega aquí las filas copiadas de Google Sheets'}<textarea id="pasteArea" rows="7" placeholder="${alumnoBulk ? 'MATRICULA<TAB>NOMBRE<TAB>CORREO<TAB>GRUPO ESPAÑOL<TAB>GRUPO INGLES<TAB>TUTOR' : k === 'asignaturas' ? 'Materia<TAB>Tipo\nMATEMÁTICAS<TAB>ESPAÑOL\nENGLISH<TAB>INGLES' : 'Grupo\n1A\n1B\n2A'}"></textarea></label><div class="actions"><button id="procesarPegado" class="p">PREVISUALIZAR FILAS</button><button id="cancelarPegado">Cancelar</button></div></div><div id="bulkEditor" class="editor" hidden></div>` : '<div id="editor" class="editor" hidden></div>'}
    <div class="tools"><input id="buscar" placeholder="Buscar..."><button id="recargar">Actualizar</button></div>
    <div class="table-wrap"><table><tr>${t.f.map(f=>`<th>${f}</th>`).join('')}<th>Acciones</th></tr>${rows.map(r=>`<tr>${t.f.map(f=>`<td>${esc(Array.isArray(r[f])?r[f].join(', '):r[f])}</td>`).join('')}<td class="actions"><button data-edit="${esc(r.id)}">Editar</button><button class="danger" data-del="${esc(r.id)}">Borrar</button></td></tr>`).join('')}</table></div>`;
  const editor=$('editor');
  const openEditor=(data={})=>{editor.hidden=false;editor.innerHTML=`<h3>${data.id?'Editar':'Nueva'} ${t.n}</h3><div class="form-grid">${formFields(t,data)}</div><div class="actions"><button class="p" id="guardarForm">Guardar</button><button id="cancelarForm">Cancelar</button></div>`;
    $('cancelarForm').onclick=()=>{editor.hidden=true}; $('guardarForm').onclick=async()=>{const o={_id:data.id||''};t.f.forEach(f=>{let v=$('n_'+f)?.value.trim()||'';if(f==='correo'||f==='docente')v=normEmail(v);if(f==='grupos')v=v.split(',').map(x=>x.trim()).filter(Boolean);o[f]=v;});if(t.fix)Object.assign(o,t.fix);if(k==='docentes'&&o.correo===ADMIN_EMAIL.toLowerCase())o.rol='admin';if(!o[t.key||t.f[0]]&&!t.key)return alert('Completa los campos obligatorios.');await guardar(t,[o]);editor.hidden=true;vistaTab(k);};
  };
  $('nuevo').onclick=()=>openEditor();
  if(bulk){
    if(alumnoBulk){
      $('plantillaAlumnos').onclick=descargarPlantillaAlumnos;
      $('excelAlumnos').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const parsed=await leerExcelAlumnos(file);if(!parsed.length)return alert('No encontré filas válidas. Verifica que el Excel tenga las columnas: MATRICULA, NOMBRE, CORREO, GRUPO ESPAÑOL, GRUPO INGLES y TUTOR.');renderBulkEditor(k,parsed,rows);}catch(err){alert('No se pudo leer el Excel: '+err.message);}e.target.value='';};
      $('bulkPaste').hidden=false;
    } else {
      $('pegarMasivo').onclick=()=>{$('bulkPaste').hidden=!$('bulkPaste').hidden;if(!$('bulkPaste').hidden){$('pasteArea').focus();}};
    }
    $('cancelarPegado').onclick=()=>{$('bulkPaste').hidden=true;$('pasteArea').value='';};
    $('procesarPegado').onclick=()=>{const parsed=parsearPegado(k,$('pasteArea').value);if(!parsed.length)return alert('No encontré filas válidas.');renderBulkEditor(k,parsed,rows);};
    $('pasteArea').addEventListener('paste',()=>setTimeout(()=>{const parsed=parsearPegado(k,$('pasteArea').value);if(parsed.length)renderBulkEditor(k,parsed,rows);},50));
  }
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
  main.innerHTML=`<h2>Mi avance</h2><table><tr><th>Grupo</th><th>Materia</th><th>Alumnos</th><th>Registros</th><th>Estado</th><th>Fecha</th></tr>${rows.map(r=>`<tr><td>${esc(r.grupo)}</td><td>${esc(r.asignatura)}</td><td>${r.alumnos||0}</td><td>${r.filas||0}</td><td>${esc(r.estado||'CARGADO')}</td><td>${fecha(r.fecha)}</td></tr>`).join('')}</table>`;
}
