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

# Instala yt-dlp via pip com o extra curl_cffi (necessário pra passar por Cloudflare).
# Evitamos o build standalone do PyInstaller de propósito: ele se descomprime a cada
# execução (~900ms medidos) e o pipeline chama o yt-dlp várias vezes por download.
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default,curl-cffi]"

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p downloads

EXPOSE 3000

# -U não vale pra instalação via pip; a atualização passa a ser pelo próprio pip.
CMD ["sh", "-c", "pip3 install --no-cache-dir --break-system-packages -U 'yt-dlp[default,curl-cffi]' || true; node server.js"]
