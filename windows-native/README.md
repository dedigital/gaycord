# Gaycord Native Windows

WPF tabanlı native Windows istemcisidir. V6 Security güncellemesinin en güçlü güvenlik özellikleri web/PWA tarafındadır: CSRF, korumalı upload ve opsiyonel E2EE. Windows istemcisi temel mesajlaşma/sesli mesaj/native kullanım içindir.

## V7.7 — Sistem ses kısma (audio ducking)

`AudioDuckingService.cs`, NAudio Core Audio (`MMDeviceEnumerator` / `AudioSessionManager` / `SimpleAudioVolume`) kullanarak aramadayken **diğer uygulamaların** uygulama-başına ses oturumlarını kısar; aramadan çıkınca/uygulama kapanınca/çökme sonrası ilk açılışta orijinal seviyelere geri yükler.

- Varsayılan **kapalı** (`LocalSettings.DuckOthers = false`).
- **Yönetici izni gerekmez** (per-session `ISimpleAudioVolume`).
- Sistem **ana ses (master)** seviyesine dokunulmaz; sadece uygulama oturumları.
- Gaycord'un kendi süreci (`Environment.ProcessId`) ve "gaycord" adlı oturumlar hariç tutulur.
- Orijinal seviyeler kısma sırasında snapshot'lanır; `Deactivate` (çıkış), `Dispose` (kapanış) ve `RecoverFromCrash` (sonraki açılış) ile geri yüklenir. Aktifken `%APPDATA%/Gaycord/duck-state.json` marker dosyası tutulur.
- UI: sağ üstteki "🔉 Oyun odağı" onay kutusu + kısma seviyesi (20/35/50/70). `MainWindow` `LiveVoiceButton` katıl/ayrıl ve `OnClosed` ile bağlanır.

### Derleme notu
`dotnet build` bu ortamda çalıştırılamadı: yalnızca .NET SDK 9.0.314 kurulu, **.NET 8 WindowsDesktop targeting pack yok** (`net8.0-windows` referans assembly'leri çözülemiyor — `IDisposable`/`Task`/`byte` dahil tüm BCL tipleri CS0246 veriyor). Bu durum bu PR'dan **bağımsızdır**: değişiklikler stash'lendiğinde baseline de aynı 97 hatayı verir. .NET 8 desktop runtime + targeting pack kurulu bir makinede `dotnet build windows-native/Gaycord.Native.csproj -c Release` ile derlenir. C# tarafı NAudio 2.2.1 Core Audio API'sine göre yazıldı ve elle gözden geçirildi.
