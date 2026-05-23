# Gaycord Server V5

```bash
npm install
npm start
```

Render:

```text
Root Directory: server
Build Command: npm install
Start Command: npm start
Health Check Path: /api/health
```

Environment:

```text
NODE_ENV=production
PUBLIC_URL=https://gaycord.onrender.com
MAX_UPLOAD_BYTES=15728640
DATABASE_URL=postgresql://...
# veya disk kullanıyorsan:
GAYCORD_DATA_DIR=/var/data/gaycord
```

`DATABASE_URL` varsa hesaplar, sunucular, kanallar, mesajlar ve küçük upload blobları PostgreSQL içinde saklanır. `DATABASE_URL` yoksa Render redeploy/restart sonrası yerel dosya verisi kalıcı olmayabilir.
