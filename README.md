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
| Google Analytics | Activos, nuevos, minutos, eventos, países, versiones, primera sesión y niveles, del periodo elegido y del anterior | 10 min |
| Google Analytics (cohortes) | Instalaciones por día de las últimas 8 semanas y cuántas siguen en D1, D3, D7, D14 y D30 | 1 h |
| AdMob | Impresiones, clics, ingresos por día y formato | 30 min |
| Unity Ads | Anuncios pedidos, vistos e ingresos por día | 30 min |
| Google Play (informes) | Instalaciones, desinstalaciones, fallos y ANR por día | 6 h (Play va 1–3 días atrás) |
| Google Play (vitals) | Tasa de fallos y ANR percibida | 6 h |

AdMob, Unity Ads y Play traen 180 días: la página elige el periodo (7, 28 o 90
días) y lo compara con el anterior sin volver a pedirlos. Solo Analytics se
consulta de nuevo al cambiar de periodo.

### Qué muestra

- **Resumen**: ingresos (AdMob + Unity + compras brutas), ARPDAU, anuncios por
  jugador al día, fill rate de AdMob, D1 y fallos percibidos, cada uno con su
  línea diaria y el cambio frente al periodo anterior. Si la muestra es pequeña
  (menos de 200 jugadores-día, 100 instalaciones, 1.000 solicitudes o 500
  usuarios en vitals), el cambio se muestra sin color.
- **Retención por semana de instalación**: tabla de cohortes D1 a D30.
- **Primera sesión**: abren el juego → tutorial → primera pieza → primera línea
  → ganan un nivel, de los jugadores nuevos del periodo.
- **Niveles**: quién empezó cada nivel, tasa de victoria frente a la que
  esperaba la dificultad adaptativa (`expected_win`) y cuántos pasan al siguiente.
- **Gráfico accesible**: se recorre con ← y →, y tiene «Ver como tabla».

### Para ver los niveles, las promociones y las campañas

En Google Analytics ▸ Administrador ▸ Definiciones personalizadas registra:

- las dimensiones de evento `level_id` y `promotion`;
- la dimensión de usuario `active_event`;
- la métrica de evento `expected_win` (unidad estándar).

### Quién entra

Entran los correos de `config/statsAccess` y cualquiera con rol en el panel de
contenido (el *custom claim* `role`). Los ingresos (AdMob, Unity y las cifras de
dinero de Analytics) los reciben la lista, los publicadores y los dueños; un
lector o un editor recibe el resto.

### Experimentos y valor por país

Con `only: ["experiment"]` y `experiment: { control, variant, since }`, la
función compara a los jugadores de dos versiones de contenido (propiedad de
usuario `content_pack`, que hay que registrar como dimensión de usuario) desde
una fecha: jugadores, sesiones, minutos, compradores, ingresos y D1 de los que
empezaron en ese tiempo. Analytics trae además el valor de un jugador por país
en 90 días (`countryValue`), solo para quien ve ingresos.

### BigQuery

`statsWarehouse` corre cada día a las 7:30 (hora de Bogotá). Con el export de
Analytics vinculado (Firebase ▸ Configuración del proyecto ▸ Integraciones ▸
BigQuery), reconstruye en el dataset `blocktrail_stats` las tablas
`daily_kpis`, `retention_cohorts` y `level_funnel`, sin testers. Mientras no
haya export, solo deja en el log que está esperando. Las páginas todavía no
leen esas tablas.

Hasta entonces, la sección Niveles explica qué falta y el resto funciona igual.
Analytics solo rellena una dimensión desde el día en que se registra.

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

**Después de cambiar un secreto hay que volver a desplegar** (paso 6): Firebase fija la versión de
cada secreto al desplegar, y la función sigue usando la anterior hasta entonces.

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
```
node --test tests/*.test.mjs
```
Los cálculos de la página (periodos, resumen, cohortes y embudos) están en
`docs/metrics.js`, sin DOM, y se prueban con `tests/metrics.test.mjs`. GitHub
Actions corre ambas pruebas en cada push (`.github/workflows/test.yml`).
