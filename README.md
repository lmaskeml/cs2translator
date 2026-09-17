# CS2 Sesli Translator

Counter-Strike 2 için **yazılı sohbet** ve **sesli konuşma** çevirisi.

Araç, CS2 `console.log` dosyasını izler, sohbet mesajlarını Google Translate ile çevirir ve isteğe bağlı olarak sistem sesinden (WASAPI loopback) yakalanan sesli konuşmaları Whisper ile yazıya döküp konsola/Türkçe çeviriye aktarır.

> **Önemli:** CS2 Steam başlatma seçeneklerinde `-condebug` olmalıdır; aksi halde `console.log` yazılmaz.

**Depo:** [https://github.com/lmaskeml/cs2translator](https://github.com/lmaskeml/cs2translator)

---

## Özellikler

### Yazılı sohbet
- `console.log` üzerinden gerçek zamanlı sohbet okuma
- Otomatik çeviri (varsayılan hedef: **Türkçe**) — konsol / web arayüzü
- Oyun içi komutlar: `tm_`, `t_`, `_tl`, `code_`
- Tarayıcıda canlı sohbet arayüzü (`http://127.0.0.1:7420`)
- Türkçe istemci etiketleri (`HERKES`, `KT` vb.) desteği

### Sesli çeviri (isteğe bağlı)
- Windows **WASAPI loopback** ile sistem sesini yakalama (oyuncu voice chat dahil)
- **faster-whisper** (açık kaynak) ile konuşmayı metne çevirme
- Google Translate ile hedef dile çeviri
- Sonuçlar **yalnızca konsol / GUI** — sohbete otomatik spam yok

### Yapılandırma
- Windows: `%APPDATA%\cs2-chat-translator\config.json`
- Linux: `~/.config/cs2-chat-translator/config.json`

---

## Gereksinimler

| Bileşen | Açıklama |
|--------|----------|
| OS | Windows 10/11 (önerilir) veya Linux |
| Node.js | 18+ |
| CS2 | Steam başlatma seçeneği: `-condebug` |
| Ses (opsiyonel) | Python 3.11 venv + `requirements-voice.txt` |

Linux’ta oyun içi `say` tetiklemek için `xdotool` gerekir. Windows’ta PowerShell kullanılır.

---

## Kurulum

```bash
git clone https://github.com/lmaskeml/cs2translator.git
cd cs2translator
npm install
```

İlk yapılandırma:

```bash
node bin/cs2-chat-translator.js --init-config
```

### Sesli çeviri (opsiyonel)

```bash
py -3.11 -m venv .venv-voice
.venv-voice\Scripts\pip install -r requirements-voice.txt
```

---

## CS2 ayarları

### 1. Konsol günlüğü (`-condebug`)

1. Steam → CS2 → Özellikler → Başlatma Seçenekleri  
2. Şunu ekleyin: `-condebug`  
3. Oyunu bir kez başlatın (`console.log` oluşsun)

Tipik yol (Windows):

```text
...\steamapps\common\Counter-Strike Global Offensive\game\csgo\console.log
```

### 2. (İsteğe bağlı) Sohbete gönderme bind’i

Komutlarla (`t_en`, `tm_`, `_tl`) çeviriyi oyuna basmak için:

```text
bind l "exec chat_reader"
```

`cfg` klasöründeki `binds.cfg` / `autoexec.cfg` içine eklenebilir.  
Varsayılan olarak otomatik sohbet basımı **kapalıdır** (spam olmasın diye); çevirileri konsoldan kopyalayıp yapıştırabilirsiniz.

---

## Kullanım

```bash
# Sohbet çevirisi + web arayüzü
node bin/cs2-chat-translator.js

# Sesli çeviri de açık
node bin/cs2-chat-translator.js --voice

# Tarayıcıyı açma
node bin/cs2-chat-translator.js --no-browser --voice

# Loopback cihaz listesi
node bin/cs2-chat-translator.js --list-voice-devices

# -condebug’ı Steam launch options’a eklemeyi dene
node bin/cs2-chat-translator.js --ensure-condebug
```

Web arayüzü: **http://127.0.0.1:7420**

---

## Oyun içi komutlar

| Komut | Açıklama | Örnek |
|-------|----------|--------|
| `tm_<dil> METİN` | Metni çevirip sohbete gönderir | `tm_de hello friends` |
| `t_<dil> METİN` | Ham çeviriyi sohbete gönderir | `t_en merhaba arkadaşlar` |
| `_tl [dil]` | Son mesajı çevirir (varsayılan `tr`) | `_tl en` |
| `code_<diladı>` | Dil kodu yardımcısı | `code_french` → `tm_fr` |

---

## Yapılandırma alanları

`config.json` örnek:

```json
{
  "logPath": "D:\\...\\game\\csgo\\console.log",
  "cfgDir": "D:\\...\\game\\csgo\\cfg",
  "bindKey": "l",
  "autoTranslate": true,
  "autoTranslateTarget": "tr",
  "myName": "oyuncu_adiniz",
  "translateOutgoing": true,
  "outgoingTarget": "en",
  "relayToChat": false,
  "voiceEnabled": true,
  "voiceModel": "tiny",
  "voiceChunkSec": 2.8,
  "voiceDevice": "auto",
  "tagCT": "CT",
  "tagT": "T",
  "tagAll": "HERKES"
}
```

| Alan | Anlamı |
|------|--------|
| `autoTranslateTarget` | Gelen sohbetin çevrileceği dil (`tr`) |
| `myName` | Kendi nick’iniz (döngü / giden çeviri için) |
| `translateOutgoing` | Kendi mesajlarınızı `outgoingTarget` diline çevir (konsol) |
| `relayToChat` | Çevirileri oyuna otomatik bas (`false` önerilir) |
| `voiceEnabled` / `--voice` | Sesli çeviriyi aç |
| `voiceDevice` | `auto` = sesi olan loopback’i seç |
| `tagAll` | Türkçe istemcide genelde `HERKES` |

---

## Nasıl çalışır?

1. CS2, `-condebug` ile sohbeti `console.log` dosyasına yazar.  
2. Araç dosyayı izler → satırları ayrıştırır → çevirir → konsola/GUI’ye yazar.  
3. `--voice` ile WASAPI loopback dinlenir → Whisper → Google Translate → konsol.  
4. İsteğe bağlı: `chat_reader.cfg` + bind tuşu ile oyuna `say` gönderimi.

---

## Sorun giderme

### `console.log` boş / sohbet gelmiyor
- Steam launch options’ta `-condebug` var mı?  
- CS2’yi tamamen kapatıp yeniden başlattınız mı?  
- `logPath` doğru mu?

### Sesli çeviri çalışmıyor
- `.venv-voice` kuruldu mu?  
- Çıktıda `mode: callback` ve `Voice ready` görünüyor mu?  
- Windows’ta CS2’nin ses çıkışı, seçilen loopback cihazıyla aynı mı?  
- `voiceDevice: "auto"` deneyin; cihaz listesi: `--list-voice-devices`

### WASAPI notu
Eski `stream.read()` sessizlikte kilitlenebiliyordu. Güncel sürüm **callback** kullanır ve açılışta aktif sesli cihazı probe eder.

---

## CLI özeti

```text
cs2-chat-translator                 # izleyici + GUI
cs2-chat-translator --voice         # + sesli çeviri
cs2-chat-translator --no-browser
cs2-chat-translator --port 7420
cs2-chat-translator --cli
cs2-chat-translator --init-config
cs2-chat-translator --set-log-path <yol>
cs2-chat-translator --set-cfg-dir <yol>
cs2-chat-translator --set-bind-key l
cs2-chat-translator --ensure-condebug
cs2-chat-translator --list-voice-devices
```

---

## Lisans

Açık kaynak. Ayrıntılar için `LICENSE` dosyasına bakın.

---

## Teşekkür

Orijinal sohbet çeviri fikri topluluk araçlarından esinlenilmiştir. Sesli çeviri: **faster-whisper** + **PyAudioWPatch** (WASAPI loopback).
