# Gaycord Server

```bash
npm install
npm start
```

Environment:

```text
NODE_ENV=production
PUBLIC_URL=https://gaycord.onrender.com
MAX_UPLOAD_BYTES=15728640
GAYCORD_DATA_DIR=/var/data/gaycord
DATABASE_URL=postgresql://...
```

`DATABASE_URL` varsa tüm hesap/sunucu/mesaj bilgisi PostgreSQL içinde saklanır. Dosyalar için Render Disk veya backup/export önerilir.
