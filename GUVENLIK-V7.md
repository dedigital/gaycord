# Gaycord V7 Security Hardening

V7, V6/V6.1 verisini PostgreSQL tarafında bozmadan sıkılaştırır. `DATABASE_URL` seçimi ve `DB_STATE_KEY=gaycord_state_v4` aynı kaldığı için mevcut kullanıcı, sunucu, kanal, mesaj ve upload kayıtları okunmaya devam eder.

## Değişiklik özeti

1. Tarayıcı içi otomatik backup kapalı kalır. Kod `localStorage.setItem(...)` kullanmaz; eski `gaycord:last-light-backup:*` anahtarlarını temizler.
2. `/api/admin/export?light=1` session, password hash/salt, mesaj ve upload içeriği döndürmez. Full export da aktif session taşımaz.
3. `/api/admin/import` ve `/api/bootstrap-import` gelen backup içindeki `sessions` alanını sıfırlar.
4. `/api/security/status` admin olmayan kullanıcılarda redakte edilir; security event ve hassas limit detayları sadece admin tarafından görülür.
5. Yeni aktif davet kodları 128-bit rastgele hex üretilir. Eski kısa kodlar açılışta rotasyona alınır.
6. `/api/servers/join` kullanıcı+IP bazlı sıkı rate-limit altına alındı.
7. REST mesaj oluşturma ve Socket.IO `message:text`, `message:voice`, `message:secure` aynı `messages` rate-limit kovasını paylaşır.
8. Mesaj saklamada mesaj başına, kanal başına ve kullanıcı başına byte limitleri uygulanır.
9. E2EE opsiyonel kalır. Kapalıyken sohbet ekranında açık uyarı görünür; açıkken mevcut V6/V6.1 AAD değerleri korunur, böylece eski şifreli mesajlar uyumlu kalır.
10. Protected upload URL'leri giriş ve kanal yetkisi ister.

## Doğrulama

```bash
cd server
npm ci
npm run test:security
```

Script şunları doğrular:

- Admin auto localStorage backup disabled
- Light export session/password hash/message/upload sızdırmıyor
- Import session restore etmiyor
- Socket.IO `message:secure` rate-limit yiyor
- Oversized E2EE payload reddediliyor
- Protected upload URL anonim erişimi reddediyor, yetkili kanal üyesine izin veriyor

## Render notu

Render için `DATABASE_URL` davranışı değiştirilmedi:

```txt
DATABASE_URL=postgresql://...
```

Bu değişiklik yeni bir PostgreSQL tablo adı veya state key'i gerektirmez.
