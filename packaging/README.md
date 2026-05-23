# Paketleme notu

Bu proje Windows için self-contained portable EXE üretir. Arkadaşların Node, npm veya PowerShell kullanmaz.

GitHub Actions sonucu oluşan `ArkadasOdasi-Windows-Native` artifact'ının içinden şunları dağıt:

- `ArkadasOdasi.exe`
- `server.txt`
- publish klasöründe oluşan ek dosyalar varsa hepsi

`server.txt` içine kendi HTTPS sunucu adresini yazarsan uygulama ilk açılışta otomatik o adresi kullanır.
