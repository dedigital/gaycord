# Gaycord Server V7

V7 Security sürümü: HTTPS arkasında çalışan Node/Socket.IO sunucusu.

## Önemli güvenlikler

- `DATABASE_URL` ile PostgreSQL kalıcı veri modu. V7 bu davranışı değiştirmez ve mevcut `gaycord_state_v4` kaydını kullanır.
- HTTP security headers + CSP
- CSRF koruması (`x-gaycord-csrf`)
- Login/register/message/join rate limit
- REST ve Socket.IO mesaj yollarında ortak `messages` rate-limit kovası
- Session tokenlarının DB içinde SHA-256 hash olarak saklanması
- 128-bit rastgele aktif davet kodları
- Mesajlarda kanal ve kullanıcı bazlı aggregate byte sınırları
- Upload dosyalarına yetki kontrolü
- Tehlikeli dosya türlerini engelleme
- Opsiyonel kanal/DM bazlı E2EE: AES-GCM + PBKDF2, anahtar sadece tarayıcıda

## Health check

```txt
/api/health
```

`storageMode: postgres` ve `persistentData: true` görüyorsan veri kalıcıdır.

## Security checks

```bash
npm ci
npm run test:security
```

Bu script V7 güvenlik regresyonlarını uçtan uca kontrol eder: localStorage backup kapalı, light export redakte, import session restore etmiyor, `message:secure` rate-limitli, büyük E2EE payload reddediliyor ve `/uploads/:fileName` auth istiyor.
