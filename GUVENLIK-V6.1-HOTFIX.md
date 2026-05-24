# Gaycord V6.1 Security Hotfix

Not: Bu belge V6.1 geçmiş notudur. Güncel V7 sertleştirme özeti ve test komutları için `GUVENLIK-V7.md` dosyasına bak.

Bu hotfix iki bulguyu kapatır:

1. Admin otomatik localStorage yedeği kaldırıldı. Eski `gaycord:last-light-backup:*` anahtarları sayfa açılışında ve logout sırasında temizlenir. `/api/admin/export?light=1` artık session, password hash, mesaj ve upload blob gibi hassas veri döndürmez. Full manuel export yine sadece admin tarafından indirilebilir ve aktif session içermez. Import işlemleri session restore etmez.

2. Socket.IO mesaj yollarına REST ile eşdeğer rate-limit eklendi. `message:text`, `message:voice` ve `message:secure` artık kullanıcı başına limitlenir. Socket.IO event buffer küçültüldü. E2EE metin ciphertext sınırı küçük tutuldu; E2EE dosya/sesli mesajlar artık büyük ciphertext'i `db.messages` içine koymak yerine client-side şifrelenmiş upload olarak saklanır, mesaj kaydında sadece küçük şifreli metadata kalır. Kanal başına toplam message JSON boyutu da kırpılır.

V7'de kontrol endpoint'i admin olmayan kullanıcılar için redakte edilir. Admin görünümünde `version: 7.0.0`, `socketRateLimit: true`, `socketSharesRestMessageRateLimit: true`, `adminAutoLocalBackup: false` görünmelidir.
