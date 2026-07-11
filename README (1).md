# Servidor de renderizado — Social Publisher 360°

Reemplaza a Creatomate usando FFmpeg gratis. Implementa los 4 endpoints que la
app espera en **⚙️ Configuración → Servidor de Video**:

- `GET  /health`
- `POST /render` — Reels e Historias simples (1 imagen o video + audio + texto)
- `POST /render-story` — Historias multi-slide
- `POST /render-carousel` — Carrusel (imágenes con texto)

## Desplegar en Railway

1. Subí esta carpeta completa a un repositorio de GitHub (podés arrastrar los
   archivos desde la web de GitHub, no hace falta usar la terminal).
2. En Railway: **New Project → Deploy from GitHub repo** → elegí este repo.
3. Andá a la pestaña **Variables** del servicio y agregá esta variable
   (¡es el paso más importante, sin esto el render falla!):

   ```
   RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg
   ```

4. Esperá a que termine el deploy. Railway te va a dar una URL pública tipo
   `https://tu-servicio.up.railway.app`.
5. Pegá esa URL en la app, en ⚙️ Configuración → 🖥 Servidor de Video.
6. Probá que ande abriendo en el navegador: `https://tu-servicio.up.railway.app/health`
   — debería devolver `{"status":"ok"}`.

## Notas técnicas

- El texto se dibuja con la fuente DejaVu Sans Bold, incluida como dependencia
  npm (`dejavu-fonts-ttf`) — no depende de fuentes del sistema.
- Los archivos renderizados se guardan en `public/renders/` y se sirven como
  archivos estáticos. Como el almacenamiento de Railway es efímero, no son
  permanentes: descargalos o publicalos poco después de generarlos.
- No uses el paquete npm `ffmpeg-static`: su binario no incluye soporte de
  `drawtext` (dibujar texto). Por eso este proyecto no lo usa — depende del
  FFmpeg del sistema, instalado vía la variable de entorno de arriba.
