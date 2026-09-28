# Calificaciones IBIME (Firebase + GitHub)

Todo se hace desde el navegador; no se instala nada.

## 1. Firebase (console.firebase.google.com)
1. Crea el proyecto. Build > **Authentication** > Sign-in method > activa **Google**.
2. Build > **Firestore Database** > Crear base de datos (modo producción).
3. Configuración del proyecto > Tus apps > agrega app **Web** y copia la config a `public/config.js`.
4. Hosting: actívalo (basta con abrir la sección y no hace falta seguir el asistente de CLI).

## 2. Apps Script (puente de lectura)
1. Nuevo proyecto en script.google.com, pega `apps-script/Code.gs` y pon tu Web API key (la misma `apiKey` de la config web).
2. Ejecuta `forzarPermisos` una vez y acepta permisos.
3. Implementar > Aplicación web > Ejecutar como: **yo** > Acceso: **cualquier persona**. Copia la URL `/exec` a `BRIDGE_URL` en `public/config.js`.
4. La cuenta dueña del script debe ser profesor en los cursos / tener acceso a los reportes (igual que hoy).

## 3. GitHub
1. Crea el repo y sube estos archivos (Add file > Upload files).
2. Google Cloud Console > IAM > Cuentas de servicio: crea una con roles **Firebase Admin** y **Consumidor de Service Usage**; crea una clave JSON.
3. Repo > Settings > Secrets and variables > Actions: secret `FIREBASE_SERVICE_ACCOUNT` (todo el JSON) y variable `FIREBASE_PROJECT` (tu projectId).
4. Cada push a `main` despliega hosting y reglas.

## 4. Primer uso
Entra con josue.jain@ibime.edu.mx (admin automático). En **Docentes** agrega correos con rol `docente` o `admin`; cambiar rol = agregar el mismo correo con otro rol.
Solo entran los correos registrados. Luego llena Grupos, Asignaturas y **Asignaciones** (docente, grupo, materia): cada docente verá su carga y solo pega los links.

Revoca el secret de Firebase que estaba en el código anterior.
