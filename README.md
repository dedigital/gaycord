# Gaycord V4.1

Discord benzeri Web/PWA + Windows Native başlangıç projesi.

## V4.1 yenilikleri

- Sesli mesaj gönderme/dinleme düzeltildi; boş kayıt bugı için parça parça kayıt alıyor.
- Canlı ses kanalı eklendi; ses kanalı ve DM içinde WebRTC ile konuşma.
- Fotoğraf/video/ses/dosya gönderme ve önizleme.
- Sunucu üyeleri sağ panelde görünür.
- Ayarlar modalı: profil, tema, kompakt mod, mikrofon testi, veri/yedek alanı.
- Veri kalıcılığı için `GAYCORD_DATA_DIR` ve `DATABASE_URL` desteği.
- Admin yedek indir/yükle.

## Render ayarları

```text
Root Directory: server
Build Command: npm install
Start Command: npm start
Health Check Path: /api/health
```

Veri gitmesin diye önerilen iki yol:

1. **PostgreSQL/Neon/Supabase/Render Postgres** kullan: Render Environment içine `DATABASE_URL` ekle.
2. **Render Disk** kullan: Disk mount path `/var/data`, Environment içine `GAYCORD_DATA_DIR=/var/data/gaycord` ekle.

Free plan ve kalıcı disk/database yoksa deploy/restart sonrası veriler garanti değildir. V4.1 içinde Ayarlar > Yedek indir/yükle var.
