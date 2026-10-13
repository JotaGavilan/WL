# Wikiloc Tracks

App web instalable (PWA) para **guardar tus rutas de Wikiloc en el dispositivo y consultarlas sin conexión**: track sobre el mapa, perfil de elevación, estadísticas, descripción del itinerario y puntos de interés.

## Qué se extrae de una ruta de Wikiloc

De la página de la ruta se obtiene, sin servidor y sin cuenta:

| Dato | Detalle |
|---|---|
| Track | Todos los puntos: longitud, latitud, **altitud** y **hora** |
| Perfil de elevación | Interactivo; se enlaza con el mapa en los dos sentidos |
| Estadísticas | Distancia, tipo de ruta, desnivel +/−, altitud máx./mín., dificultad, tiempo, TrailRank |
| Itinerario | Descripción completa de la ruta |
| Puntos de interés | Nombre, tipo, altitud, hora y posición en el track |
| Ficha | Título, ubicación, autor, fecha de realización |

Las cifras de desnivel y altitud son **las que muestra Wikiloc** en la página. Los cálculos propios a partir del track se guardan aparte (`stats.calc`) porque Wikiloc suaviza la altitud más que esta app y salen valores algo mayores.

## Mis rutas: varias rutas y selección rápida

- La pantalla de inicio es **«Mis rutas»**: una tarjeta por ruta con miniatura del recorrido (inicio verde, fin rojo), distancia, desnivel, tiempo y tipo. Toca una tarjeta y se abre la ruta cargada en el mapa, con perfil, estadísticas e itinerario.
- **Buscar** por nombre, ubicación o autor, y **ordenar** por más recientes, nombre, distancia o desnivel.
- Dentro de una ruta, **← Rutas** vuelve a la galería (también el botón Atrás del móvil) y el desplegable de la barra superior cambia de ruta sin salir. Al recargar, la app reabre la última ruta.
- **Importar varias a la vez:** *+ Añadir ruta* admite seleccionar varios `.html` y `.gpx` juntos, o arrastrarlos a la ventana. Se muestra un informe con las rutas guardadas, las actualizadas y las que fallaron (con el motivo); un archivo erróneo no impide guardar los demás.

## Cómo importar una ruta

Wikiloc no ofrece API pública y su descarga de GPX exige iniciar sesión, así que la app lee **la propia página de la ruta**, que ya lleva el track incrustado. Hay tres formas:

1. **Página guardada (la más fiable).** En Wikiloc abre la ruta, espera a que cargue el mapa y guarda con **Ctrl+S → «Página web completa»**. En la app: *Añadir ruta* → elige uno o varios `.html`. También acepta `.gpx`.
2. **Marcador del navegador.** En *Añadir ruta* arrastra el botón a la barra de marcadores. Estando en una ruta de Wikiloc, púlsalo: la ruta se envía a la app y se guarda. Algunos navegadores o sitios bloquean marcadores; si pasa, usa la opción 1.
3. **Pegar la URL (opcional, experimental).** Necesita un proxy propio (`worker/`, abajo) y Wikiloc puede bloquearlo.

Volver a importar la misma ruta **la actualiza**, no la duplica.

> El formato interno de las páginas de Wikiloc no está documentado y puede cambiar sin aviso. Está probado contra una ruta real guardada (Lagos de Ayous, 1 967 puntos): distancia, desnivel, altitudes y tiempo coinciden con los de la página. Úsalo con tus propias rutas y respetando las condiciones de uso de Wikiloc.

## Uso sin conexión

- **Rutas:** se guardan en IndexedDB y la app pide al navegador almacenamiento persistente para que no las borre al faltar espacio. Importar, ver, buscar, renombrar, borrar y exportar GPX/KML funciona sin red: el análisis se hace en el dispositivo.
- **App:** un service worker guarda todos los archivos (incluido Leaflet), así que arranca sin conexión una vez abierta con red al menos una vez.
- **Mapa de fondo:** sin red solo se ven las teselas que ya se hayan cargado. Para tener el mapa de la zona, pulsa **«Guardar mapa de la zona»** en la ruta (con conexión): se descargan unas decenas de teselas alrededor del track, hasta un máximo de 600, de forma espaciada y una sola vez. Se guarda la capa que tengas activa. Sin ese paso el track, el perfil y los datos siguen viéndose, pero sobre fondo gris.
- **Copia de seguridad:** botón *Copia de seguridad* (JSON) y *Restaurar*. No incluye las teselas.

Necesitan conexión: abrir el enlace de Google Maps, el enlace a Wikiloc y descargar teselas nuevas.

## Posición GPS

Botón **◎** del mapa (a la izquierda, bajo el zoom):
- **Primera pulsación:** activa el GPS, centra el mapa en ti y lo acerca. Aparece un punto azul con el círculo de precisión.
- **Perfil:** marca dónde vas con una línea azul («Tú · 8,1 km»).
- **Panel:** «Llevas X km · faltan Y km (Z %)», altitud GPS y precisión. Si estás lejos del track avisa («Estás a 170 m del track»); el margen crece si el GPS es poco preciso.
- **Seguir:** el mapa te sigue mientras caminas. Si arrastras el mapa, deja de seguirte hasta que pulses «Seguirme».
- **◎ con el GPS activo:** vuelve a centrarte y acerca (zoom 17 o más). **⤢** muestra la ruta completa. **Parar GPS** lo desactiva.
- **Sin conexión:** el GPS del dispositivo no necesita internet; con la ruta y el mapa guardados funciona igual. La pantalla se mantiene encendida mientras el GPS está activo (si el navegador lo permite).
- El navegador pide permiso de ubicación la primera vez. En móvil, la página debe abrirse por HTTPS (GitHub Pages lo es).

El GPS usa la ubicación del dispositivo en el propio navegador; no se envía a ningún servidor.

## Fondos de mapa y zoom

Selector de fondos arriba a la derecha: **Calles (OpenStreetMap)**, **Topográfico (OpenTopoMap)**, **Topográfico (Esri)** y **Satélite (Esri)**, con la capa opcional **Nombres y lugares** sobre el satélite. La app recuerda el fondo elegido. Se puede acercar hasta el zoom 20: más allá del detalle que ofrece cada servidor el mapa se amplía. «Guardar mapa de la zona» guarda el fondo activo (y los nombres, si están activados); puedes guardar varios fondos de la misma ruta y se acumulan.

## Puesta en marcha

### 1. Publicar en GitHub Pages
1. Sube el proyecto a la rama `main` de un repositorio.
2. En *Settings → Pages*, en *Source* elige **GitHub Actions**.
3. El workflow `.github/workflows/pages.yml` ejecuta las pruebas y publica en `https://TU_USUARIO.github.io/NOMBRE_REPO/`.
4. Abre esa URL y usa «Instalar app» (o el menú del navegador → *Instalar / Añadir a pantalla de inicio*). Ábrela una vez con conexión para que quede todo guardado.

### 2. (Opcional) Proxy para importar pegando la URL
```bash
cd worker
npx wrangler login
npx wrangler deploy
# opcional: restringir el origen en wrangler.toml (ALLOWED_ORIGIN) y guardar tu cookie como secreto
npx wrangler secret put WIKILOC_COOKIE
```
Copia la URL del Worker en **Ajustes** de la app (o en `config.js`, `proxyUrl`). El proxy devuelve el HTML de la ruta y la app lo procesa con el mismo extractor que usa con la página guardada. La cookie es la de **tu propia sesión**; es un secreto y nunca debe ir en el código.

## Desarrollo
```bash
npm test         # pruebas: GPX, estadísticas, extractor de Wikiloc (con una página real recortada), GPS y proxy
npm start        # servidor local en http://localhost:8080
```

## Estructura
```
index.html, config.js, manifest.webmanifest, sw.js   PWA
css/styles.css          estilos (claro/oscuro)
js/wikiloc-page.js      extractor de la página de Wikiloc (TWKB → track, POI, estadísticas, descripción)
js/importer.js          construye la ruta guardada desde HTML de Wikiloc, GPX o proxy
js/gpx.js               parser GPX, estadísticas, exportación GPX/KML
js/db.js                almacenamiento IndexedDB
js/offline.js           guardado de teselas, almacenamiento persistente
js/geo.js               posición sobre el track: km recorridos, distancia al track
js/gps.js               GPS: punto en el mapa, panel, marca en el perfil
js/profile.js           perfil de elevación en <canvas>
js/app.js               interfaz y mapa
vendor/                 Leaflet 1.9.4 (incluido)
worker/                 proxy opcional de Cloudflare Workers
tests/                  node:test + fixtures
```

## Notas
- Google Maps no admite cargar un track completo por enlace: el botón abre una ruta a pie aproximada (inicio, fin y 8 puntos intermedios). Para el track exacto, exporta el KML e impórtalo en [Google My Maps](https://www.google.com/mymaps).
- Las teselas de OpenStreetMap/OpenTopoMap tienen políticas de uso razonable y desaconsejan las descargas masivas. El guardado de la zona está limitado a propósito; para un uso intensivo, usa un proveedor propio.
