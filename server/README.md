# Gaycord Server V6

V6 Security sürümü: HTTPS arkasında çalışan Node/Socket.IO sunucusu.

## Önemli güvenlikler

- `DATABASE_URL` ile PostgreSQL kalıcı veri modu
- HTTP security headers + CSP
- CSRF koruması (`x-gaycord-csrf`)
- Login/register/message rate limit
- Session tokenlarının DB içinde SHA-256 hash olarak saklanması
- Upload dosyalarına yetki kontrolü
- Tehlikeli dosya türlerini engelleme
- Opsiyonel kanal/DM bazlı E2EE: AES-GCM + PBKDF2, anahtar sadece tarayıcıda

## Health check

```txt
/api/health
```

`storageMode: postgres` ve `persistentData: true` görüyorsan veri kalıcıdır.
