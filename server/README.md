# Arkadaş Odası Server

Web/PWA istemcisini sunar, REST API sağlar, Socket.IO ile web sohbetini, `/native` WebSocket endpoint'iyle Windows istemcisini konuşturur.

## Komutlar

```bash
npm install
npm start
```

## Ortam değişkenleri

- `PORT`: hosting servisinin verdiği port. Varsayılan `3000`.
- `PUBLIC_URL`: yayınlanan HTTPS adresi. Örn. `https://senin-uygulaman.onrender.com`.
- `MAX_UPLOAD_BYTES`: ses/dosya yükleme sınırı. Varsayılan 15 MB.
