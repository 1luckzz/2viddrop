FROM node:20-slim

# Instala dependências do sistema
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Instala yt-dlp — build standalone (PyInstaller), que já traz curl_cffi embutido.
# O binário "yt-dlp" puro (zipimport) roda no python3 do sistema SEM curl_cffi, e aí
# qualquer site atrás de Cloudflare falha pedindo "--extractor-args generic:impersonate".
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p downloads

EXPOSE 3000

# Atualiza o yt-dlp a cada inicialização (YouTube quebra versões antigas com frequência)
CMD ["sh", "-c", "yt-dlp -U || true; node server.js"]
