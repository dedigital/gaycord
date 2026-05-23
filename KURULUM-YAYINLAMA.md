# Node / PowerShell uğraşmadan yayınlama

Bu dosya arkadaşların için değil; sadece senin bir kez yayınlaman için.

## 1) Sunucu için

1. GitHub'da yeni repository aç.
2. Bu paketin içindeki dosyaları GitHub web arayüzünden yükle.
3. Render/Railway/Fly gibi bir yerde yeni web service oluştur.
4. Repo'yu bağla.
5. Ayarlar:
   - Root Directory: `server`
   - Build Command: `npm install`
   - Start Command: `npm start`
6. Deploy bitince verilen HTTPS adresini kopyala.

Bu adresten web sürüm açılır. Arkadaşların linke girer; localhost gerekmez.

## 2) Windows uygulaması için

1. GitHub repo sayfasında `Actions` sekmesine gir.
2. `Build Windows Native App` workflow'unu çalıştır.
3. İş bitince `ArkadasOdasi-Windows-Native` artifact'ını indir.
4. İçindeki `server.txt` dosyasına kendi HTTPS adresini yaz.
5. Klasörü zipleyip arkadaşlarına gönder.

Arkadaşların sadece `ArkadasOdasi.exe` dosyasını açar.

## 3) Web mi app mi?

- Web için HTTPS yayınla.
- Windows için EXE gönder.
- İkisi de aynı sunucuya bağlanır.
