# Gaycord V6.1 Security Hotfix

Bu hotfix iki bulguyu kapatır:

1. Admin otomatik localStorage yedeği kaldırıldı. Eski `gaycord:last-light-backup:*` anahtarları sayfa açılışında ve logout sırasında temizlenir. `/api/admin/export?light=1` artık session, password hash, mesaj ve upload blob gibi hassas veri döndürmez. Full manuel export yine sadece admin tarafından indirilebilir ve aktif session içermez. Import işlemleri session restore etmez.

2. Socket.IO mesaj yollarına REST ile eşdeğer rate-limit eklendi. `message:text`, `message:voice` ve `message:secure` artık kullanıcı başına limitlenir. Socket.IO event buffer küçültüldü. E2EE metin ciphertext sınırı küçük tutuldu; E2EE dosya/sesli mesajlar artık büyük ciphertext'i `db.messages` içine koymak yerine client-side şifrelenmiş upload olarak saklanır, mesaj kaydında sadece küçük şifreli metadata kalır. Kanal başına toplam message JSON boyutu da kırpılır.

Kontrol endpoint'i: `/api/security/status` içinde `version: 6.1.0`, `socketRateLimit: true`, `adminAutoLocalBackup: false` görünmelidir.
