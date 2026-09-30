# Meekz Drop

Downloader de vídeos com frontend HTML/CSS e backend Node.js usando yt-dlp.
Acesso restrito: quem quer usar cria uma conta e o dono aprova.

---

## Requisitos

- **Node.js** 22+
- Um projeto no **Supabase** (Auth + Postgres) para as contas
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
2viddrop/
├── public/               ← estático e público: CSS, JS, login/cadastro/espera, páginas legais
├── private/              ← páginas só para logado: index.html (aprovados) e admin.html (admin)
├── auth/                 ← sessão em cookie, repositório Supabase, guardas e rotas /auth e /admin
├── twitter/              ← feature Twitter/X (/api/twitter)
├── video/                ← corte de intro com ffmpeg
├── test/                 ← node --test
├── downloads/            ← arquivos temporários (auto-deletados)
├── server.js             ← Express + yt-dlp
└── render.yaml           ← deploy no Render (Docker)
```

---

## Variáveis de Ambiente

| Variável              | Padrão   | Descrição                                                          |
|-----------------------|----------|--------------------------------------------------------------------|
| `SUPABASE_URL`        | —        | **Obrigatória.** URL do projeto Supabase                            |
| `SUPABASE_SECRET_KEY` | —        | **Obrigatória.** Chave secreta (`sb_secret_...` ou `service_role`)  |
| `SESSION_SECRET`      | —        | **Obrigatória.** Segredo do cookie de sessão (32+ bytes em hex)     |
| `ADMIN_EMAIL`         | —        | **Obrigatória.** E-mail do dono; é quem entra em `/admin`           |
| `PORT`                | `3000`   | Porta do servidor                                                  |
| `YTDLP_BIN`           | `yt-dlp` | Caminho customizado do executável                                  |

---

## Login e aprovação

O site inteiro fica atrás de login. Fluxo:

1. A pessoa abre `/cadastro`, cria a conta (e-mail e senha) e cai em `/aguardando`.
2. Você entra com o e-mail de `ADMIN_EMAIL` (cadastre-se como qualquer pessoa: esse
   e-mail é sempre tratado como aprovado e admin) e abre `/admin`.
3. Em `/admin`, aba **Pendentes**, clique **Aprovar**. A pessoa recarrega `/aguardando`
   e entra. **Bloquear** tira o acesso na hora.

As contas ficam no Supabase Auth e o status na tabela `viddrop_profiles`
(migração `viddrop_profiles`, projeto `spm-homolog`). Só o servidor acessa a tabela,
com a chave secreta.

Local: copie `.env.example` para `.env`, preencha e rode

```bash
node --env-file=.env server.js
```

Sem as quatro variáveis o servidor não sobe e diz qual falta.

Esqueceu a senha (ou a conta já existia no projeto Supabase compartilhado)? Defina uma
nova pelo terminal, com o `.env` preenchido:

```bash
node --env-file=.env scripts/definir-senha.js seu@email.com "senha nova"
```

---

## Deploy no Render

1. Suba o projeto no GitHub
2. Crie um Web Service no Render
3. O `render.yaml` já fixa o runtime Docker e o health check em `/healthz`
4. No painel do serviço, preencha `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_SECRET` e `ADMIN_EMAIL`

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

- ✅ Login com e-mail e senha; só usuário aprovado pelo admin baixa
- ✅ Buscar informações do vídeo (título, thumbnail, duração)
- ✅ Selecionar qualidade: 4K, 1080p, 720p, 480p
- ✅ Extrair apenas áudio em MP3
- ✅ Barra de progresso em tempo real (SSE)
- ✅ Download automático do arquivo ao concluir
- ✅ Auto-delete de arquivos após 10 minutos
- ✅ Limpeza automática a cada 1 hora
- ✅ Suporte a +1000 sites (YouTube, Instagram, TikTok, Twitter, etc.)
