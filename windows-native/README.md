# Arkadaş Odası Native Windows

Bu istemci WPF ile yazılmış gerçek Windows uygulamasıdır; Electron değildir. Mesajlar ve sesli mesajlar sunucu API'sine gider. Canlı ses odası native istemciler arasında WebSocket üstünden PCM ses paketleriyle çalışır.

## Build

Normalde GitHub Actions derler. Yerelde derlemek isteyen geliştirici Windows'ta şunu çalıştırabilir:

```powershell
dotnet publish .\ArkadasOdasi.Native.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o .\publish
```

Arkadaşların bunu çalıştırmaz; sadece çıkan EXE'yi açar.
