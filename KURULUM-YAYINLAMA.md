# Gaycord V4.1 kurulum/yayınlama

## Mevcut GitHub repona güncelleme

1. Bu zip'i çıkar.
2. İçindeki dosyaları mevcut `gaycord` repo klasörünün içine kopyala ve değiştir.
3. GitHub Desktop:

```text
Summary: Gaycord V4.1 update
Commit to main
Push origin
```

4. Render otomatik deploy etmezse:

```text
Render > gaycord > Manual Deploy > Deploy latest commit
```

Deploy bitince kontrol:

```text
https://gaycord.onrender.com/api/health
```

Cevapta `version: 4.1.0` görmelisin.

## Veriler gitmesin diye

En sağlam seçenek PostgreSQL kullanmak:

```text
Render > Environment > Add Environment Variable
DATABASE_URL = postgresql://...
```

Alternatif Render Disk:

```text
Disk mount path: /var/data
Environment Variable:
GAYCORD_DATA_DIR = /var/data/gaycord
```

Kalıcı disk/database yoksa Render Free üzerinde deploy veya restart sonrası hesaplar/mesajlar garanti değildir. V4.1'de ilk kayıt olan yönetici Ayarlar'dan yedek indirip yükleyebilir.

## Windows app

GitHub Actions'ta build bitince artifact:

```text
Gaycord-Windows-Native
```

İndir, `server.txt` içine şu linki yaz:

```text
https://gaycord.onrender.com
```

Sonra klasörü zipleyip arkadaşlarına gönderebilirsin.
