# Arkadaş Odası V2

Bu paket iki parçadan oluşur:

1. `server/` — Web/PWA + API + gerçek zamanlı mesajlaşma sunucusu.
2. `windows-native/` — Electron olmayan, WPF tabanlı gerçek Windows istemcisi.

Arkadaşların Node, npm, PowerShell veya localhost ile uğraşmaz. Sen sunucuyu bir kere internete koyarsın; onlar ya HTTPS linkinden web sürümünü açar ya da Windows uygulamasını indirip çalıştırır.

## Özellikler

- Kayıt / giriş
- Sunucu oluşturma
- Davet koduyla sunucuya katılma
- Kanal ve DM mesajlaşması
- Arkadaş ekleme / gelen isteği kabul etme
- Sesli mesaj kaydetme ve gönderme
- Native Windows istemcileri arasında canlı ses odası
- Web/PWA arayüzü
- GitHub Actions ile portable Windows EXE üretimi

## En kolay yayınlama mantığı

- Sunucu tek yerde çalışır: örn. Render/Railway/Fly/VPS.
- Arkadaşlar `localhost` kullanmaz.
- Web için URL şöyle olur: `https://senin-uygulaman.onrender.com`
- Windows uygulaması açılışta aynı URL'e bağlanır.

## Web sunucusunu yayınlama

GitHub'da yeni repo açıp bu klasördeki dosyaları yükle.

Render gibi bir serviste yeni Web Service oluştur:

- Root directory: `server`
- Build command: `npm install`
- Start command: `npm start`
- Environment variable, opsiyonel: `PUBLIC_URL=https://senin-uygulaman.onrender.com`

Deploy bitince sana HTTPS linki verir. Bu link hem web uygulamasıdır hem de Windows uygulamasının bağlanacağı sunucudur.

## Windows uygulamasını EXE yapmak

Bu repoyu GitHub'a yükledikten sonra:

1. GitHub repo sayfasında `Actions` sekmesine gir.
2. `Build Windows Native App` workflow'unu aç.
3. `Run workflow` de.
4. İş bitince artifact olarak `ArkadasOdasi-Windows-Native` çıkar.
5. İçinden `ArkadasOdasi.exe` dosyasını indir.

Arkadaşların sadece EXE'yi açar. Bilgisayarlarında Node/npm gerekmez.

### Sunucu adresini uygulamaya gömmek

EXE ile aynı klasöre `server.txt` koyup içine kendi HTTPS adresini yaz:

```txt
https://senin-uygulaman.onrender.com
```

Bunu zipleyip arkadaşlarına gönderirsen uygulama ilk açılışta doğru sunucu URL'i ile gelir.

## Yerelde test etmek isteyen geliştirici için

```bash
cd server
npm install
npm run dev
```

Sonra web: `http://localhost:3000`

## Notlar

Bu hâl Discord'un bire bir aynısı değildir; ama kendi arkadaş grubun için gerçek çalışan bir başlangıç sistemidir. Çok büyütmek istersen veritabanını JSON yerine PostgreSQL/SQLite'a almak, dosya depolamayı kalıcı storage'a taşımak, rate limit ve moderasyon eklemek gerekir.
