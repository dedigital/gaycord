# Gaycord V5 kurulum/yayınlama

## Mevcut GitHub repona güncelleme

1. Bu zip'i çıkar.
2. Zip içindeki `gaycord-v5` klasörünü aç.
3. İçindeki dosyaları mevcut `gaycord` repo klasörünün içine kopyala ve değiştir.
4. GitHub Desktop:

```text
Summary: Gaycord V5 layout and persistence fix
Commit to main
Push origin
```

5. Render otomatik deploy etmezse:

```text
Render > gaycord > Manual Deploy > Deploy latest commit
```

Deploy bitince kontrol:

```text
https://gaycord.onrender.com/api/health
```

Cevapta şunlar görünmeli:

```text
app: gaycord-v5
version: 5.0.0
```

## Hesaplar/sunucular tekrar silinmesin

Kod düzeltmesi tek başına bunu çözemez; Render'da kalıcı veri alanı açman gerekir. En kolay ve sağlam yöntem PostgreSQL'dir.

Render'da:

```text
Render > gaycord > Environment > Add Environment Variable
Key: DATABASE_URL
Value: postgresql://...
Save Changes
```

Sonra Render yeni deploy başlatır. Bittiğinde uygulama Ayarlar > Veri kalıcılığı bölümünde `Kalıcı veri aktif` göstermeli.

Alternatif Render Disk:

```text
Disk mount path: /var/data
Environment Variable:
GAYCORD_DATA_DIR=/var/data/gaycord
```

Önemli: Şu ana kadar silinen eski veriyi geri getiremezsin; eski deploydan yedek indirmediysen Render'ın geçici dosya sistemi onu silmiş olabilir. Ama `DATABASE_URL` ekledikten sonra sonraki güncellemelerde aynı veriyi okumaya devam eder.

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

## Güncellemeden önce önerilen güvenli yol

1. Varsa mevcut çalışan sitede admin hesabınla giriş yap.
2. `Ayarlar > Yedek > Yedek indir` ile yedek al.
3. V5'i pushla.
4. PostgreSQL `DATABASE_URL` ekle.
5. Deploydan sonra eski hesap yoksa giriş ekranındaki yedek yükleme ile geri getir.

Tarayıcıdaki otomatik yedek butonu yalnızca veritabanı tamamen boşsa görünür. Bu sayede yanlışlıkla dolu sistemi ezmez.
