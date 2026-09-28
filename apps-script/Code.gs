// Puente de lectura: recibe {idToken, url} y devuelve los valores del Sheets.
// Publicar: Implementar > Aplicación web > Ejecutar como: yo > Acceso: cualquier persona.
// La cuenta dueña debe tener acceso (profesor) a los reportes, igual que antes.
var WEB_API_KEY = "PEGA_AQUI_TU_WEB_API_KEY_DE_FIREBASE";
var DOMINIO = "@ibime.edu.mx";

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var email = verificar(req.idToken);
    if (!email || email.slice(-DOMINIO.length) !== DOMINIO) return out({ ok: false, error: "No autorizado" });
    var m = String(req.url).match(/\/d\/(.+?)(\/|$)/);
    if (!m) return out({ ok: false, error: "URL inválida" });
    var datos = SpreadsheetApp.openById(m[1]).getSheets()[0].getDataRange().getDisplayValues();
    return out({ ok: true, datos: datos });
  } catch (err) {
    return out({ ok: false, error: "Sin acceso o link roto" });
  }
}

function verificar(idToken) {
  if (!idToken) return null;
  var cache = CacheService.getScriptCache(), k = idToken.slice(-40);
  var hit = cache.get(k);
  if (hit) return hit;
  var r = UrlFetchApp.fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + WEB_API_KEY,
    { method: "post", contentType: "application/json", payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true });
  var u = JSON.parse(r.getContentText()).users;
  if (!u) return null;
  var email = String(u[0].email).toLowerCase();
  cache.put(k, email, 600);
  return email;
}

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function forzarPermisos() { UrlFetchApp.fetch("https://www.google.com"); SpreadsheetApp.getActive(); }
