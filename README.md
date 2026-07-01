# VidDrop — Instalador de Vídeos

Downloader de vídeos com frontend HTML/CSS e backend Node.js usando yt-dlp.

---

## Requisitos

- **Node.js** 18+
- **yt-dlp** instalado e no PATH
- **ffmpeg** instalado (para merge de vídeo+áudio)

---

## Instalação Rápida

### 1. Instalar yt-dlp

**Windows:**
```powershell
winget install yt-dlp
# ou manualmente: baixar yt-dlp.exe de https://github.com/yt-dlp/yt-dlp/releases
```

**Linux/Mac:**
```bash
pip install yt-dlp
# ou
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

### 2. Instalar ffmpeg

**Windows:** https://ffmpeg.org/download.html → adicionar ao PATH

**Linux:**
```bash
sudo apt install ffmpeg
```

**Mac:**
```bash
brew install ffmpeg
```

### 3. Instalar dependências e rodar

```bash
npm install
npm start
```

Acesse: **http://localhost:3000**

---

## Estrutura

```
video-downloader/
├── public/
│   ├── index.html    ← Frontend
│   ├── style.css     ← Estilos
│   └── app.js        ← JavaScript do cliente
├── downloads/        ← Arquivos temporários (auto-deletados em 10 min)
├── server.js         ← Backend Express + yt-dlp
├── package.json
└── README.md
```

---

## Variáveis de Ambiente

| Variável      | Padrão    | Descrição                              |
|---------------|-----------|----------------------------------------|
| `PORT`        | `3000`    | Porta do servidor                      |
| `YTDLP_BIN`   | `yt-dlp`  | Caminho customizado do executável      |

---

## Deploy no Render

1. Suba o projeto no GitHub
2. Crie um Web Service no Render
3. Build command: `npm install`
4. Start command: `npm start`
5. Adicione a variável `YTDLP_BIN` se necessário

> **Atenção:** O Render free tier não tem yt-dlp por padrão. Use um Dockerfile ou instale via script de build.

### Dockerfile (opcional)

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y python3 pip ffmpeg \
 && pip install yt-dlp --break-system-packages
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

---

## Funcionalidades

- ✅ Buscar informações do vídeo (título, thumbnail, duração)
- ✅ Selecionar qualidade: 4K, 1080p, 720p, 480p
- ✅ Extrair apenas áudio em MP3
- ✅ Barra de progresso em tempo real (SSE)
- ✅ Download automático do arquivo ao concluir
- ✅ Auto-delete de arquivos após 10 minutos
- ✅ Limpeza automática a cada 1 hora
- ✅ Suporte a +1000 sites (YouTube, Instagram, TikTok, Twitter, etc.)
