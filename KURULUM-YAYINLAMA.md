# Gaycord V3 kurulum / yayınlama

## 1. Dosyaları repoya kopyala

Bu paketin içindeki her şeyi mevcut `gaycord` GitHub repo klasörüne kopyala. Aynı dosyalar sorulursa **Değiştir / Replace** de.

Repo kökünde şöyle görünmeli:

```text
.github
packaging
server
windows-native
.gitignore
render.yaml
README.md
KURULUM-YAYINLAMA.md
```

GitHub Desktop'ta:

```text
Summary: Gaycord V3 update
Commit to main
Push origin
```

## 2. Render yeniden deploy

Render genelde push sonrası otomatik deploy eder. Etmezse:

```text
Render > gaycord > Manual Deploy > Deploy latest commit
```

Ayarlar:

```text
Language: Node
Branch: main
Root Directory: server
Build Command: npm install
Start Command: npm start
Health Check Path: /api/health
```

Deploy bitince kontrol:

```text
https://gaycord.onrender.com/api/health
```

`gaycord-v3` cevabı gelmeli.

## 3. Windows native app

GitHub'da:

```text
Actions > Build Gaycord Windows App
```

Yeşil build'in en altında artifact indir:

```text
Gaycord-Windows-Native
```

Zip'i çıkar. İçindeki `server.txt` içine kendi Render linkini yaz:

```text
https://gaycord.onrender.com
```

Klasörü tekrar zipleyip arkadaşlarına atabilirsin.

## Notlar

- Free Render instance kullanılmayınca uyuyabilir; ilk giriş 30-60 saniye sürebilir.
- Daha hızlı ve sürekli açık olması için sonra Starter plana geçebilirsin.
- Windows uyarısı normaldir; exe kod imzalı değilse Windows "bilinmeyen yayıncı" diyebilir.
