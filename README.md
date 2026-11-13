# BlockTrail Estadísticas

Panel privado con las estadísticas de BlockTrail: jugadores en tiempo real,
retención, eventos, ingresos de AdMob y Unity Ads, e instalaciones y fallos de
Google Play.

- **Página** (`docs/`): HTML y JavaScript en GitHub Pages. No contiene secretos.
- **Inicio de sesión**: Firebase Auth con Google. Solo entran los correos de la
  lista `config/statsAccess` en Firestore.
- **Backend** (`functions/`): una Cloud Function (`stats`) que comprueba quién
  pregunta, consulta las fuentes y guarda cada respuesta unos minutos en
  Firestore (`statsCache/*`). Si una fuente falla, devuelve su último dato bueno
  marcado como antiguo.

| Fuente | Qué trae | Frescura |
|---|---|---|
| Google Analytics (tiempo real) | Jugando ahora, instalaciones, niveles y anuncios de los últimos 30 min | 1 min |
| Google Analytics | Activos, nuevos, minutos, retención D1/D7, eventos, países, versiones | 10 min |
| AdMob | Impresiones, clics, ingresos por día y formato | 30 min |
| Unity Ads | Anuncios pedidos, vistos e ingresos por día | 30 min |
| Google Play (informes) | Instalaciones, desinstalaciones, fallos y ANR por día | 6 h (Play va 1–3 días atrás) |
| Google Play (vitals) | Tasa de fallos y ANR percibida | 6 h |

## Puesta en marcha

Todo en el proyecto de Firebase **bock-quest-game**.

### 1. Plan Blaze
Firebase ▸ ⚙ ▸ Uso y facturación ▸ **Modificar plan ▸ Blaze**. Las Cloud Functions
lo exigen. Con este uso (unas decenas de llamadas al día) suele quedar en $0;
pon una **alerta de presupuesto** de, por ejemplo, $5 en Google Cloud ▸ Facturación ▸ Presupuestos.

### 2. App web y Google como proveedor
1. Firebase ▸ ⚙ Configuración del proyecto ▸ Tus apps ▸ **Agregar app ▸ Web**
   (nombre «Estadísticas», sin Hosting). Copia `apiKey` y `appId` en
   `docs/firebase-config.js`.
2. Firebase ▸ Authentication ▸ Método de acceso ▸ **Google ▸ Habilitar**.
3. Authentication ▸ Configuración ▸ Dominios autorizados ▸ **Agregar dominio**:
   `ferwinred.github.io`.

### 3. Quién puede entrar
Firestore ▸ Iniciar colección `config` ▸ documento `statsAccess` ▸ campo
`emails` de tipo **array** con un correo por elemento. Para dar o quitar acceso
basta editar esa lista.

### 4. Secretos
Con la [CLI de Firebase](https://firebase.google.com/docs/cli) (`npx firebase-tools`),
desde esta carpeta:

```
npx firebase-tools login
npx firebase-tools functions:secrets:set STATS_OAUTH_CLIENT_ID
npx firebase-tools functions:secrets:set STATS_OAUTH_CLIENT_SECRET
npx firebase-tools functions:secrets:set STATS_OAUTH_REFRESH_TOKEN
npx firebase-tools functions:secrets:set STATS_UNITY_API_KEY
```

- Los tres `STATS_OAUTH_*` son el cliente OAuth «Agente AdMob» y su token de
  renovación (solo lectura de Analytics, Play, Cloud Storage y AdMob).
- `STATS_UNITY_API_KEY`: Unity Cloud ▸ Monetization ▸ API management ▸ Monetization Stats API key.

### 5. Parámetros
Al desplegar, la CLI pregunta los que no tienen valor; los demás traen uno por defecto:
`GA4_PROPERTY` (542428799), `PLAY_BUCKET`, `ADMOB_APP_ID`, `UNITY_ORG_ID` (id de
organización de Unity) y `UNITY_GAME_ID` (opcional).

### 6. Desplegar **solo la función**
```
npx firebase-tools deploy --only functions:stats
```
**Nunca** despliegues reglas de Firestore desde aquí: el juego usa sus propias reglas
(partidas, regalos de testers) y se pisarían.

### 7. Página
GitHub Pages sirve `docs/` de la rama `main` en
`https://ferwinred.github.io/blocktrail-stats/`.

## Desarrollo
```
cd functions && npm install && npm test
```
