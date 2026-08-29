// Corte de abertura: quais URLs entram na regra e o corte real com ffmpeg.
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const assert = require('assert');
const test   = require('node:test');
const { execFileSync, spawnSync } = require('child_process');

const { precisaCortar, segundosParaCortar, cortarInicio } = require('../video/trim');

// ── domínios ──────────────────────────────────────────────────
test('links do Pornhub e do CDN dele entram na regra dos 5s', () => {
  const alvos = [
    'https://pt.pornhub.com/view_video.php?viewkey=672a22890a8a2',
    'https://www.pornhub.com/view_video.php?viewkey=abc',
    'https://pornhub.com/view_video.php?viewkey=abc',
    'https://rt.pornhub.com/view_video.php?viewkey=abc',
    'https://www.pornhubpremium.com/view_video.php?viewkey=abc',
    'https://ev.phncdn.com/videos/202411/05/460091431/240P_1000K_460091431.mp4',
    'https://di.phncdn.com/videos/qualquer/coisa.m3u8',
  ];
  for (const url of alvos) {
    assert.strictEqual(segundosParaCortar(url), 5, url);
    assert.ok(precisaCortar(url), url);
  }
});

test('outros sites não são cortados', () => {
  const fora = [
    'https://www.xvideos.com/video123/titulo',
    'https://vazounudes.net/hls/UID/480p/video.m3u8',
    'https://www.youtube.com/watch?v=abc',
    'https://x.com/user/status/123',
    'https://cdn.exemplo.com/stream.m3u8',
  ];
  for (const url of fora) {
    assert.strictEqual(segundosParaCortar(url), 0, url);
    assert.ok(!precisaCortar(url), url);
  }
});

test('um domínio que só termina parecido não passa como Pornhub', () => {
  // sufixo de host, não substring: senão qualquer site poderia se disfarçar
  assert.strictEqual(segundosParaCortar('https://pornhub.com.outrosite.net/v/1'), 0);
  assert.strictEqual(segundosParaCortar('https://naopornhub.com/v/1'), 0);
  assert.strictEqual(segundosParaCortar('https://phncdn.com.evil.net/v.mp4'), 0);
});

test('entrada inválida não derruba', () => {
  for (const v of ['', null, undefined, 'nem url', 42, {}]) {
    assert.strictEqual(segundosParaCortar(v), 0, String(v));
  }
});

// ── corte real com ffmpeg ─────────────────────────────────────
const ffmpegOk = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

function duracao(arquivo) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', arquivo,
  ]).toString().trim();
  return Number(out);
}

function gerarVideo(destino, segundos) {
  execFileSync('ffmpeg', [
    '-nostdin', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=15:duration=${segundos}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${segundos}`,
    '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    destino,
  ], { stdio: 'ignore' });
}

test('corta o começo de um vídeo de verdade', { skip: !ffmpegOk && 'ffmpeg ausente' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-'));
  const src = path.join(dir, 'video.mp4');

  try {
    gerarVideo(src, 12);
    assert.ok(Math.abs(duracao(src) - 12) < 0.5, 'o vídeo de teste tem ~12s');

    const saida = await cortarInicio(src, 5, 'ffmpeg');
    assert.notStrictEqual(saida, src, 'devolve um arquivo novo');
    assert.ok(fs.existsSync(saida));
    assert.ok(!fs.existsSync(src), 'o original é apagado');

    const nova = duracao(saida);
    // -c copy corta no keyframe mais próximo: sobra perto de 7s, não exato
    assert.ok(nova > 5.5 && nova < 8.5, `duração após o corte: ${nova.toFixed(2)}s`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vídeo mais curto que o corte sai intacto', { skip: !ffmpegOk && 'ffmpeg ausente' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-'));
  const src = path.join(dir, 'curto.mp4');

  try {
    gerarVideo(src, 2);
    const antes = fs.statSync(src).size;

    const saida = await cortarInicio(src, 5, 'ffmpeg');
    assert.strictEqual(saida, src, 'devolve o próprio original');
    assert.ok(fs.existsSync(src), 'o original continua lá');
    assert.strictEqual(fs.statSync(src).size, antes, 'e intacto');
    assert.ok(!fs.existsSync(path.join(dir, 'curto_cortado.mp4')), 'sem sobra do corte falho');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ffmpeg inexistente devolve o original em vez de quebrar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-'));
  const src = path.join(dir, 'x.mp4');
  try {
    fs.writeFileSync(src, Buffer.alloc(9000, 1));
    const saida = await cortarInicio(src, 5, 'ffmpeg-que-nao-existe-1234');
    assert.strictEqual(saida, src);
    assert.ok(fs.existsSync(src));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('arquivo ausente ou corte de 0s não fazem nada', async () => {
  assert.strictEqual(await cortarInicio('/nao/existe.mp4', 5, 'ffmpeg'), '/nao/existe.mp4');
  assert.strictEqual(await cortarInicio('/tanto/faz.mp4', 0, 'ffmpeg'), '/tanto/faz.mp4');
});
