const CACHE = 'ibime-kardex-v9';
const APP_SHELL = [
  './', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest',
  './alumnos/', './alumnos/index.html', './alumnos/alumno.js', './alumnos/alumno.css', './alumnos/manifest.webmanifest',
  './assets/logo-ibime.png', './assets/favicon-64.png', './assets/apple-touch-icon.png',
  './assets/icon-192.png', './assets/icon-512.png', './assets/icon-maskable-512.png'
];
self.addEventListener('install', event => {
  // cache:'reload' evita guardar copias viejas del caché HTTP del navegador.
  event.waitUntil(caches.open(CACHE)
    .then(cache => cache.addAll(APP_SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const esCodigo = (req, url) => req.mode === 'navigate' || /\.(js|css|html|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');
const guardar = (req, res) => { if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; };
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const respaldo = () => caches.match(req).then(c => c || caches.match(url.pathname.startsWith('/alumnos') ? './alumnos/index.html' : './index.html'));
  if (esCodigo(req, url)) {
    // Código de la app: siempre la versión más nueva; la caché solo sirve sin conexión.
    event.respondWith(fetch(req).then(res => guardar(req, res)).catch(respaldo));
  } else {
    event.respondWith(caches.match(req).then(c => c || fetch(req).then(res => guardar(req, res)).catch(respaldo)));
  }
});
