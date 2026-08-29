// Corte de abertura.
// Alguns sites entregam o vídeo com alguns segundos de vinheta antes do
// conteúdo. O corte usa `-c copy`: o ffmpeg copia os bytes a partir do
// keyframe mais próximo, sem recodificar — leva menos de um segundo e não
// mexe na qualidade. Em troca, o ponto de corte cai no keyframe, então o
// trecho removido fica perto do pedido, não exato.
'use strict';

const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');

// Quantos segundos tirar do início, por domínio.
const REGRAS = [
  { dominios: ['pornhub.com', 'pornhubpremium.com', 'phncdn.com'], segundos: 5 },
];

// Um mp4 menor que isto é só cabeçalho, sem conteúdo aproveitável.
const MIN_BYTES = 4096;

// Casa o domínio exato ou um subdomínio dele. Comparar por sufixo de host
// evita que 'pornhub.com.outrosite.net' passe como se fosse do Pornhub.
function casaDominio(hostname, dominio) {
  return hostname === dominio || hostname.endsWith('.' + dominio);
}

function segundosParaCortar(url) {
  let hostname;
  try { hostname = new URL(String(url)).hostname.toLowerCase(); }
  catch { return 0; }

  const regra = REGRAS.find(r => r.dominios.some(d => casaDominio(hostname, d)));
  return regra ? regra.segundos : 0;
}

function precisaCortar(url) {
  return segundosParaCortar(url) > 0;
}

// Devolve o caminho do arquivo cortado. Se o corte falhar por qualquer
// motivo, devolve o original intacto: entregar o vídeo inteiro é melhor
// que não entregar nada.
function cortarInicio(arquivo, segundos, ffmpegBin = 'ffmpeg') {
  return new Promise(resolve => {
    if (!segundos || !arquivo || !fs.existsSync(arquivo)) return resolve(arquivo);

    const ext   = path.extname(arquivo) || '.mp4';
    const saida = arquivo.slice(0, arquivo.length - ext.length) + '_cortado' + ext;

    let bytesOriginal = 0;
    try { bytesOriginal = fs.statSync(arquivo).size; } catch { return resolve(arquivo); }

    const args = [
      '-nostdin', '-y',
      '-ss', String(segundos),   // antes do -i: busca o keyframe sem decodificar
      '-i', arquivo,
      '-c', 'copy',
      '-movflags', '+faststart',
      saida,
    ];

    const desistir = () => {
      try { fs.unlinkSync(saida); } catch {}
      resolve(arquivo);
    };

    let proc;
    try {
      proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      return desistir();
    }

    proc.on('error', desistir);
    proc.on('close', code => {
      let ok = false;
      try {
        const bytes = fs.statSync(saida).size;
        // Quando o corte passa do fim do material, o ffmpeg devolve o vídeo
        // inteiro em vez de um arquivo vazio — sai do mesmo tamanho. Aí não
        // há corte a entregar e o original serve, sem cópia à toa.
        ok = code === 0 && bytes >= MIN_BYTES && bytes < bytesOriginal;
      } catch {}
      if (!ok) return desistir();

      try { fs.unlinkSync(arquivo); } catch {}
      resolve(saida);
    });
  });
}

module.exports = { precisaCortar, segundosParaCortar, cortarInicio, REGRAS };
