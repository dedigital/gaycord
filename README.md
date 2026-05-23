# Gaycord V3

Gaycord; arkadaşlarla sunucu, kanal, DM, dosya ve sesli mesaj için hazırlanmış web/PWA + native Windows chat uygulamasıdır.

## V3 yenilikleri

- Uygulama adı ve marka tamamen **Gaycord** olarak güncellendi.
- Kullanıcının verdiği Gaycord logosu web, PWA, favicon ve Windows app ikonlarına eklendi.
- Web arayüzü baştan tasarlandı.
- Sunucu silme eklendi.
- Sunucudan çıkma eklendi.
- Kanal silme eklendi.
- Sunucu adını değiştirme eklendi.
- Web dosya gönderme eklendi.
- Sol menü / satır taşması düzeltildi.
- Windows native uygulamasının başlığı, logosu ve exe adı Gaycord oldu.
- GitHub Actions artifact adı `Gaycord-Windows-Native` oldu.

## Render ayarları

Render Web Service ayarları:

```text
Language: Node
Root Directory: server
Build Command: npm install
Start Command: npm start
Health Check Path: /api/health
```

## Lokal çalıştırma

```bash
cd server
npm install
npm run dev
```

Sonra:

```text
http://localhost:3000
```

## Windows app build

GitHub > Actions > **Build Gaycord Windows App** > Run workflow.

Build bitince artifact:

```text
Gaycord-Windows-Native
```

Zip'i indir, çıkar, `server.txt` içine Render linkini yaz:

```text
https://gaycord.onrender.com
```

Sonra `Gaycord.exe` çalıştır.
