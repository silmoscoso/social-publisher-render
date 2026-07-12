/**
 * Social Publisher 360° — Servidor de renderizado gratuito
 * Reemplaza a Creatomate usando FFmpeg. Pensado para correr en Railway (plan gratuito).
 *
 * Endpoints que la app espera encontrar en cfg.apis.server:
 *   GET  /health           → chequeo de que el servidor está vivo
 *   POST /render           → Reels / Historias simples (1 imagen o video + texto + audio)
 *   POST /render-story     → Historias multi-slide (varias slides con TITULO/SUBTITULO/CTA)
 *   POST /render-carousel  → Carrusel (varias imágenes con TITULO/TEXTO superpuesto)
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const ffmpeg = require('fluent-ffmpeg');
// Usamos el ffmpeg del sistema (instalado vía apt en Railway), NO el binario del paquete
// npm "ffmpeg-static": ese binario viene compilado sin soporte de drawtext/libfreetype.
if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);

const FONT_BOLD = path.join(
  path.dirname(require.resolve('dejavu-fonts-ttf/package.json')),
  'ttf',
  'DejaVuSans-Bold.ttf'
);

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TMP_DIR = path.join(ROOT, 'tmp');
const RENDERS_DIR = path.join(ROOT, 'public', 'renders');
[TMP_DIR, RENDERS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/renders', express.static(RENDERS_DIR, { maxAge: '1h' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, uid() + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
});

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function publicUrl(req, filename) {
  return `${req.protocol}://${req.get('host')}/renders/${filename}`;
}

function dims(format) {
  if (format === 'square') return { w: 1080, h: 1080 };
  if (format === 'horizontal') return { w: 1920, h: 1080 };
  return { w: 1080, h: 1920 }; // vertical (default: reels/historias)
}

// Escapa texto para usar dentro de un filtro drawtext de ffmpeg
function esc(t) {
  return String(t == null ? '' : t)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")
    .replace(/%/g, '\\%');
}

// Corta el texto en varias líneas para que no se salga del cuadro
function wrap(t, maxChars) {
  const words = String(t == null ? '' : t).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (next.length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

function hexToFF(color, alpha) {
  const hex = (color || '#7c3aed').replace('#', '');
  return `0x${hex}@${alpha != null ? alpha : 1}`;
}

function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    client
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlink(dest, () => {});
          return downloadTo(response.headers.location, dest).then(resolve, reject);
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error('No se pudo descargar ' + url + ' (status ' + response.statusCode + ')'));
        }
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

// Resuelve un archivo de entrada: prioriza el file subido, si no hay usa la URL
async function resolveInput(file, url, ext) {
  if (file) return { path: file.path, mimetype: file.mimetype };
  if (url) {
    const dest = path.join(TMP_DIR, uid() + ext);
    await downloadTo(url, dest);
    const guessedMime = /\.(jpe?g|png|webp)$/i.test(dest) ? 'image/jpeg' : /\.(mp4|mov|webm)$/i.test(dest) ? 'video/mp4' : 'audio/mpeg';
    return { path: dest, mimetype: guessedMime };
  }
  return null;
}

function runFfmpeg(cmd) {
  return new Promise((resolve, reject) => {
    cmd
      .on('start', (c) => console.log('[ffmpeg]', c))
      .on('error', (err, stdout, stderr) => {
        console.error('[ffmpeg error]', err.message, stderr);
        reject(err);
      })
      .on('end', () => resolve())
      .run();
  });
}

function cleanup(paths) {
  for (const p of paths) {
    if (p) fs.unlink(p, () => {});
  }
}

// ── Construye el filtro de texto (hook / subtitle / cta) sobre un video/imagen ──
function buildTextFilters({ w, h, text, subtitle, cta, color }) {
  const filters = [];
  const boxColor = hexToFF(color, 0.55);

  if (text) {
    filters.push(
      `drawtext=fontfile='${FONT_BOLD}':text='${esc(wrap(text, 22))}':fontsize=${Math.round(w / 16)}:fontcolor=white:` +
        `box=1:boxcolor=${boxColor}:boxborderw=18:line_spacing=6:x=(w-text_w)/2:y=h*0.12`
    );
  }
  if (subtitle) {
    filters.push(
      `drawtext=fontfile='${FONT_BOLD}':text='${esc(wrap(subtitle, 28))}':fontsize=${Math.round(w / 22)}:fontcolor=white:` +
        `box=1:boxcolor=0x000000@0.45:boxborderw=14:line_spacing=6:x=(w-text_w)/2:y=(h-text_h)/2`
    );
  }
  if (cta) {
    filters.push(
      `drawtext=fontfile='${FONT_BOLD}':text='${esc(wrap(cta, 24))}':fontsize=${Math.round(w / 20)}:fontcolor=white:` +
        `box=1:boxcolor=${boxColor}:boxborderw=16:line_spacing=6:x=(w-text_w)/2:y=h*0.82`
    );
  }
  return filters;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── POST /render — Reel o Historia simple (1 imagen o video + audio + texto) ──
app.post('/render', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
  const cleanupPaths = [];
  try {
    const { text = '', subtitle = '', cta = '', format = 'vertical', color = '#7c3aed' } = req.body;
    const duration = parseFloat(req.body.duration) || 30;
    const start = parseFloat(req.body.start) || 0;
    const { w, h } = dims(format);

    const videoFile = req.files?.video?.[0];
    const audioFile = req.files?.audio?.[0];
    if (!videoFile) return res.status(400).json({ success: false, error: 'Falta el archivo de imagen/video' });
    cleanupPaths.push(videoFile.path, audioFile?.path);

    const isImage = videoFile.mimetype.startsWith('image/');
    const outName = `render_${uid()}.mp4`;
    const outPath = path.join(RENDERS_DIR, outName);

    const textFilters = buildTextFilters({ w, h, text, subtitle, cta, color });
    const scaleFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    const vf = [scaleFilter, ...textFilters].join(',');

    const cmd = ffmpeg();

    if (isImage) {
      cmd.input(videoFile.path).inputOptions(['-loop 1']).duration(duration);
      if (audioFile) cmd.input(audioFile.path);
      cmd
        .videoFilters(vf)
        .outputOptions(['-pix_fmt yuv420p', '-r 30'])
        .videoCodec('libx264');
      if (audioFile) {
        cmd.audioCodec('aac').outputOptions(['-shortest']);
      } else {
        cmd.noAudio();
      }
    } else {
      cmd.input(videoFile.path).inputOptions([`-ss ${start}`, '-threads 1']).duration(duration);
      if (audioFile) {
        cmd.input(audioFile.path);
        cmd.outputOptions(['-map 0:v:0', '-map 1:a:0', '-shortest']);
        cmd.audioCodec('aac');
      } else {
        cmd.audioCodec('aac');
      }
      cmd.videoFilters(vf).videoCodec('libx264').outputOptions(['-pix_fmt yuv420p']);
    }
    // Configuración de bajo consumo de memoria: necesaria porque el plan
    // gratuito de Railway tiene solo 1GB de RAM. Sin esto, videos de fuente
    // en alta resolución (ej: 4K de celular) hacen que ffmpeg sea matado
    // por el sistema (SIGKILL / OOM) antes de terminar.
    cmd.outputOptions(['-preset ultrafast', '-threads 1', '-max_muxing_queue_size 1024']);

    cmd.output(outPath);
    await runFfmpeg(cmd);
    cleanup(cleanupPaths);
    res.json({ success: true, url: publicUrl(req, outName) });
  } catch (err) {
    cleanup(cleanupPaths);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /render-story — Historia multi-slide → un solo MP4 concatenado ──
app.post('/render-story', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
  const cleanupPaths = [];
  try {
    const { imageUrl = '', audioUrl = '' } = req.body;
    const duration = parseFloat(req.body.duration) || 7;
    let slides = [];
    try {
      slides = JSON.parse(req.body.slides || '[]');
    } catch {
      slides = [];
    }
    if (!slides.length) slides = [{}];

    const image = req.files?.image?.[0] || (imageUrl ? await resolveInput(null, imageUrl, '.jpg') : null);
    const audio = req.files?.audio?.[0] || (audioUrl ? await resolveInput(null, audioUrl, '.mp3') : null);
    if (!image) return res.status(400).json({ success: false, error: 'Falta la imagen de la historia' });
    cleanupPaths.push(image.path, audio?.path);

    const { w, h } = dims('vertical');
    const clipPaths = [];

    for (let i = 0; i < slides.length; i++) {
      const s = slides[i] || {};
      const textFilters = buildTextFilters({ w, h, text: s.TITULO, subtitle: s.SUBTITULO, cta: s.CTA, color: '#7c3aed' });
      const vf = [`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`, ...textFilters].join(',');
      const clipPath = path.join(TMP_DIR, `slide_${uid()}.mp4`);
      const cmd = ffmpeg()
        .input(image.path)
        .inputOptions(['-loop 1'])
        .duration(duration)
        .videoFilters(vf)
        .outputOptions(['-pix_fmt yuv420p', '-r 30'])
        .videoCodec('libx264')
        .noAudio()
        .outputOptions(['-preset ultrafast', '-threads 1'])
        .output(clipPath);
      await runFfmpeg(cmd);
      clipPaths.push(clipPath);
      cleanupPaths.push(clipPath);
    }

    const listPath = path.join(TMP_DIR, `list_${uid()}.txt`);
    fs.writeFileSync(listPath, clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    cleanupPaths.push(listPath);

    const silentPath = path.join(TMP_DIR, `silent_${uid()}.mp4`);
    cleanupPaths.push(silentPath);
    await runFfmpeg(
      ffmpeg().input(listPath).inputOptions(['-f concat', '-safe 0']).outputOptions(['-c copy']).output(silentPath)
    );

    const outName = `story_${uid()}.mp4`;
    const outPath = path.join(RENDERS_DIR, outName);
    const totalDuration = duration * slides.length;

    if (audio) {
      await runFfmpeg(
        ffmpeg()
          .input(silentPath)
          .input(audio.path)
          .inputOptions(['-stream_loop', '-1'])
          .outputOptions(['-map 0:v:0', '-map 1:a:0', '-shortest', '-t', String(totalDuration)])
          .videoCodec('copy')
          .audioCodec('aac')
          .output(outPath)
      );
    } else {
      fs.copyFileSync(silentPath, outPath);
    }

    cleanup(cleanupPaths);
    res.json({ success: true, url: publicUrl(req, outName) });
  } catch (err) {
    cleanup(cleanupPaths);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /render-carousel — cada slide se devuelve como imagen (jpg) ──
app.post('/render-carousel', upload.fields([{ name: 'image', maxCount: 1 }]), async (req, res) => {
  const cleanupPaths = [];
  try {
    const { imageUrl = '' } = req.body;
    let slides = [];
    try {
      slides = JSON.parse(req.body.slides || '[]');
    } catch {
      slides = [];
    }
    if (!slides.length) slides = [{}];

    const image = req.files?.image?.[0] || (imageUrl ? await resolveInput(null, imageUrl, '.jpg') : null);
    if (!image) return res.status(400).json({ success: false, error: 'Falta la imagen del carrusel' });
    cleanupPaths.push(image.path);

    const { w, h } = { w: 1080, h: 1350 }; // formato feed 4:5
    const results = [];

    for (let i = 0; i < slides.length; i++) {
      const s = slides[i] || {};
      const textFilters = buildTextFilters({ w, h, text: s.TITULO, subtitle: s.TEXTO, cta: '', color: '#7c3aed' });
      const vf = [`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`, ...textFilters].join(',');
      const outName = `carousel_${uid()}.jpg`;
      const outPath = path.join(RENDERS_DIR, outName);
      const cmd = ffmpeg().input(image.path).outputOptions(['-frames:v 1', '-q:v 2']).videoFilters(vf).output(outPath);
      await runFfmpeg(cmd);
      results.push({ url: publicUrl(req, outName) });
    }

    cleanup(cleanupPaths);
    res.json({ success: true, slides: results });
  } catch (err) {
    cleanup(cleanupPaths);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Servidor de render escuchando en el puerto ${PORT}`));

