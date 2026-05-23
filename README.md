# Gaycord V5

Discord benzeri Web/PWA + gerçek Windows Native başlangıç projesi.

## V5 düzeltmeleri

- Mesaj balonlarında tek tek harf alta düşme hatası düzeltildi.
- Alt taraftaki kırmızı/mavi şerit ve boş satır görüntüsü kapatıldı.
- Sol üst logo ve sunucu rail alanı daha düzgün sığacak şekilde yenilendi.
- Render üzerinde veri kalıcı değilse uygulama artık uyarı gösterir.
- `DATABASE_URL` veya kalıcı disk varsa hesaplar, sunucular, mesajlar ve dosya bilgileri güncellemelerde korunur.
- Service worker cache sürümü `v5.0` yapıldı; eski arayüz takılırsa `Ctrl + F5` yeterli olur.

## Render ayarları

```text
Root Directory: server
Build Command: npm install
Start Command: npm start
Health Check Path: /api/health
```

## Veriler silinmesin diye zorunlu ayar

Render'ın varsayılan dosya sistemi kalıcı değildir. Sadece kod güncellemesi yapmak, yerel dosyaya yazılmış hesap/sunucu/mesaj verilerini korumaz.

En sağlam çözüm PostgreSQL kullanmak:

```text
Render > gaycord > Environment > Add Environment Variable
Key: DATABASE_URL
Value: postgresql://...
```

Sonra:

```text
Manual Deploy > Deploy latest commit
```

Alternatif olarak Render Disk kullanacaksan:

```text
Disk mount path: /var/data
Environment Variable:
GAYCORD_DATA_DIR=/var/data/gaycord
```

`DB_STATE_KEY` değişkenini elle değiştirme. Varsayılan anahtar bilerek sabit tutuldu; gelecek güncellemelerde aynı PostgreSQL verisini okumaya devam eder.

## Windows app

GitHub Actions artifact adı:

```text
Gaycord-Windows-Native
```

Zip'i indir, `server.txt` içine kendi Render linkini yaz:

```text
https://gaycord.onrender.com
```

Sonra `Gaycord.exe` çalışır.

## V5.0 ek güvenlik

- Admin hesabı giriş yaptığında uygulama tarayıcıya hafif bir yedek kaydetmeye çalışır. Render geçici dosyası sıfırlanırsa giriş ekranında “Tarayıcıdaki son yedeği geri yükle” butonu çıkar.
- Bu otomatik yedek özellikle hesap/sunucu/mesaj metinlerini kurtarmak içindir; büyük fotoğraf/ses dosyaları için yine Ayarlar > Yedek indir kullan.
