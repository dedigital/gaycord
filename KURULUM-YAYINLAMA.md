# Gaycord V6 Security kurulum/yayınlama

1. `gaycord-v6.zip` dosyasını çıkar.
2. Zip içindeki `gaycord-v6` klasörünün içindeki dosya/klasörleri mevcut `gaycord` repo klasörüne kopyala.
3. GitHub Desktop:

```txt
Summary: Gaycord V6 security update
Commit to main
Push origin
```

4. Render otomatik deploy etmezse:

```txt
Render > gaycord > Manual Deploy > Deploy latest commit
```

5. Deploy sonrası kontrol:

```txt
https://gaycord.onrender.com/api/health
```

Şu alanları görmelisin:

```txt
app: gaycord-v6
version: 6.0.0
storageMode: postgres
persistentData: true
```

## Kalıcı veri

Render web service Environment bölümünde şu olmalı:

```txt
DATABASE_URL = Internal Database URL
```

## E2EE kullanımı

1. Kanal veya DM aç.
2. Üstte `🔓 E2EE` butonuna bas.
3. En az 8 karakterlik ortak anahtar yaz.
4. Arkadaşına aynı anahtarı Gaycord dışında söyle.
5. Bu mod açıkken yeni metin/dosya/foto/sesli mesajlar server tarafından okunamaz.

Anahtar servera gönderilmez. Anahtar unutulursa şifreli mesajlar açılamaz.
