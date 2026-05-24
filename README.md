# Gaycord V6 Security

Gaycord; arkadaşlarla sunucu/DM tabanlı mesajlaşma, sesli mesaj, fotoğraf/dosya gönderme ve ses odası için hazırlanmış web/PWA + Windows native istemcili küçük Discord benzeri projedir.

## V6 Security güncellemesi

- Uygulama adı ve logo Gaycord olarak kalır.
- PostgreSQL bağlıysa hesaplar, sunucular, mesajlar ve uploadlar güncellemelerde silinmez.
- Security headers ve CSP eklendi.
- CSRF koruması eklendi.
- Login/register/message rate-limit eklendi.
- Session tokenları veritabanında düz token olarak değil SHA-256 hash olarak tutulur.
- Upload dosyaları artık herkese açık değil; aynı kanala erişimi olan giriş yapmış kullanıcılar görebilir.
- SVG/HTML/JS/EXE gibi tehlikeli upload türleri engellenir.
- Ayarlar > Güvenlik bölümü eklendi.
- Kanal/DM başlığındaki kilit butonuyla opsiyonel E2EE açılabilir.

## E2EE nasıl çalışır?

Bir kanal veya DM seç, üstteki `🔓 E2EE` butonuna bas ve ortak bir anahtar yaz. Aynı anahtarı arkadaşlarınla uygulama dışından paylaş. Bu mod açıkken yeni metin mesajları, dosya/fotoğraf ve sesli mesajlar tarayıcıda AES-GCM ile şifrelenir; sunucu sadece ciphertext saklar.

Not: E2EE anahtarını unutursan eski şifreli mesajlar açılamaz. Canlı ses odası bu sürümde HTTPS/WebRTC üzerinden gider; E2EE kilidi canlı ses için değil mesaj/dosya/sesli mesaj içindir.

## Render ayarı

Kalıcı veri için web service Environment kısmında şu zorunlu:

```txt
DATABASE_URL=postgresql://...
```

Deploy sonrası kontrol:

```txt
https://gaycord.onrender.com/api/health
```

Beklenen önemli alanlar:

```json
{ "app": "gaycord-v6.1", "version": "6.1.0", "storageMode": "postgres", "persistentData": true }
```

## Güncelleme

Zip içindeki `gaycord-v6.1` klasörünün içindekileri repo köküne kopyala, GitHub Desktop ile commit/push yap. Render otomatik deploy eder.
