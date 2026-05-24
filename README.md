# Gaycord V7 Security

Gaycord; arkadaşlarla sunucu/DM tabanlı mesajlaşma, sesli mesaj, fotoğraf/dosya gönderme ve ses odası için hazırlanmış web/PWA + Windows native istemcili küçük Discord benzeri projedir.

## V7 güvenlik güncellemesi

- PostgreSQL veri anahtarı aynı kalır: `gaycord_state_v4`. Mevcut kullanıcılar, sunucular, kanallar, mesajlar ve upload kayıtları V7 ile uyumludur.
- Render `DATABASE_URL` davranışı değiştirilmedi. `DATABASE_URL` veya `POSTGRES_URL` varsa PostgreSQL, yoksa dosya modu kullanılır.
- Aktif yeni davet kodları 128-bit rastgele hex olarak üretilir. Eski zayıf davet kodları açılışta yeni güçlü kodla değiştirilir.
- `/api/servers/join` sıkı rate-limit altındadır.
- REST mesaj oluşturma ve Socket.IO `message:text`, `message:voice`, `message:secure` aynı kullanıcı bazlı rate-limit kovasını paylaşır.
- Mesaj saklama boyutu mesaj başına, kanal başına ve kullanıcı başına sınırlandırılır.
- `/api/security/status` admin olmayan kullanıcılara redakte yanıt döndürür.
- Oturum tokenları veritabanında düz token olarak değil SHA-256 hash olarak tutulur.
- Upload dosyaları herkese açık değildir; aynı kanala erişimi olan giriş yapmış kullanıcılar görebilir.
- Tarayıcı `localStorage` içine session token, password hash, backup veya secret yazılmaz. Eski `gaycord:last-light-backup:*` anahtarları temizlenir.
- E2EE kaldırılmadı. Kanal/DM başlığındaki kilit butonuyla opsiyonel E2EE açılabilir; kapalıyken arayüz net uyarı gösterir.

## E2EE nasıl çalışır?

Bir kanal veya DM seç, üstteki `🔓 E2EE` butonuna bas ve ortak bir anahtar yaz. Aynı anahtarı arkadaşlarınla uygulama dışından paylaş. Bu mod açıkken yeni metin mesajları, dosya/fotoğraf ve sesli mesajlar tarayıcıda AES-GCM ile şifrelenir; sunucu sadece ciphertext saklar.

Not: E2EE anahtarını unutursan eski şifreli mesajlar açılamaz. Canlı ses odası bu sürümde HTTPS/WebRTC üzerinden gider; E2EE kilidi canlı ses için değil mesaj/dosya/sesli mesaj içindir.

## Render ayarı

Kalıcı veri için web service Environment kısmında şu önerilir:

```txt
DATABASE_URL=postgresql://...
```

Deploy sonrası kontrol:

```txt
https://gaycord.onrender.com/api/health
```

Beklenen önemli alanlar:

```json
{ "app": "gaycord-v7", "version": "7.0.0", "storageMode": "postgres", "persistentData": true }
```

## Testler

```bash
cd server
npm ci
npm run test:security
```

`test:security` geçici bir dosya veritabanı ile sunucuyu başlatır ve localStorage backup kapalı mı, light export hassas veri sızdırıyor mu, import session restore ediyor mu, `message:secure` rate-limit yiyor mu, büyük E2EE payload reddediliyor mu ve korumalı upload URL'leri auth istiyor mu diye kontrol eder.
