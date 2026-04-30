# Grepo Toolkit — Village Agent

Zelfgebouwde Grepolis farm-automatisering die draait op GitHub Actions. Geen open PC nodig.

---

## Projectstructuur

```
grepo-toolkit/
├── config.json                        ← Alle instellingen (hoofdbestand)
├── cookies.json                       ← Wordt aangemaakt via GitHub Secret
├── package.json
├── .gitignore
├── .github/workflows/
│   ├── bot.yml                        ← Village Agent (elke 50 min)
│   ├── daily-report.yml               ← Dagelijks rapport (23u Belgisch)
│   └── keepalive.yml                  ← Elke 6u lege commit
└── src/
    ├── index.js                       ← Opstartpunt
    ├── daily-report.js                ← Dagrapport script
    ├── auth/
    │   ├── session.js                 ← Login via cookies → Puppeteer fallback
    │   └── cookie-refresher.js        ← Puppeteer login flow
    ├── api/
    │   └── grepolis.js                ← API wrapper
    ├── modules/
    │   └── village-agent.js           ← Farm logica + dagschema + stats
    └── utils/
        ├── logger.js                  ← Winston, Europe/Brussels tijdzone
        └── mailer.js                  ← E-mailrapporten
```

---

## Configuratie (config.json)

Dit is het enige bestand dat je normaal hoeft aan te passen.

### Account

```json
"account": {
  "world": "nl133",
  "player_id": 1361000,
  "towns": [
    {
      "id": 329,
      "name": "Stad van Marcotics",
      "island_x": 475,
      "island_y": 503
    }
  ]
}
```

Steden worden automatisch herkend uit de gamepagina. De `towns` lijst dient als fallback. Coördinaten vind je via F12 → Netwerk → `farm_town_overviews` request → Payload tab.

### Dagschema

```json
"intervals": {
  "A": { "label": "10 min", "interval_minutes": 10 },
  "B": { "label": "40 min", "interval_minutes": 40 },
  "C": { "label": "3u",     "interval_minutes": 180 },
  "D": { "label": "8u",     "interval_minutes": 480 }
},
"dagschema": {
  "blokken": [
    { "actief": false, "van": "00:00", "tot": "06:30", "interval": "D" },
    { "actief": true,  "van": "06:30", "tot": "12:00", "interval": "A" },
    { "actief": true,  "van": "12:00", "tot": "17:30", "interval": "A" },
    { "actief": true,  "van": "17:30", "tot": "23:00", "interval": "A" },
    { "actief": false, "van": "23:00", "tot": "24:00", "interval": "D" }
  ]
}
```

- Zet `actief` op `false` om een blok uit te schakelen
- Kies interval via de letter A/B/C/D

### Overige instellingen

```json
"opties": {
  "extra_pauze_kans":      0.10,
  "extra_pauze_min_min":   5,
  "extra_pauze_max_min":   10,
  "rapport_elke_n_rondes": 999,
  "captcha_pauze_min":     45,
  "sessie_refresh_uren":   6
}
```

---

## GitHub Secrets instellen

Ga naar repo → **Settings → Secrets → Actions → New repository secret**

| Secret | Inhoud |
|---|---|
| `GREPO_EMAIL` | Jouw Grepolis e-mailadres |
| `GREPO_PASSWORD` | Jouw Grepolis wachtwoord |
| `GREPO_COOKIES` | Cookie-Editor JSON export (fallback login) |
| `SMTP_USER` | Jouw Gmail-adres |
| `SMTP_PASS` | Gmail app-wachtwoord |
| `SMTP_TO` | Bestemmingsadres voor rapporten |

### Gmail app-wachtwoord aanmaken
1. Ga naar [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Genereer een app-wachtwoord voor "Mail"
3. Gebruik de 16-cijferige code als `SMTP_PASS`

---

## Login flow

De bot probeert in volgorde:
1. **Bestaande cookies** (`GREPO_COOKIES` secret) — snel, geen browser nodig
2. **Puppeteer** — logt automatisch in via de game-website

Bij sessie-verlies (bv. inloggen op GSM) herstart de bot automatisch via Puppeteer.

---

## Cookies exporteren

**In Microsoft Edge:**
1. Installeer **Cookie-Editor** via de [Edge Add-ons store](https://microsoftedge.microsoft.com/addons/detail/cookie-editor/neaplmfkghagebokkhpjpoebhdledlfi)
2. Log in bij Grepolis en ga naar je game
3. Klik op Cookie-Editor → **Export** → **Export as JSON**
4. Ga naar GitHub → Settings → Secrets → `GREPO_COOKIES` → plak de inhoud

---

## Automatisch draaien

- **GitHub Actions cron**: elke 50 minuten
- **cron-job.org**: externe trigger als backup (elke 50 minuten)
- **Keepalive**: elke 6 uur lege commit om de scheduler wakker te houden
- **Concurrency**: nooit meer dan één instantie tegelijk

Handmatig starten: **Actions → Grepo Toolkit — Village Agent → Run workflow**

---

## Logs begrijpen

Bij opstart:
```
[Village Agent] ✓ 06:30–12:00 → A (10 min, elke ~10 min)
[Village Agent] Huidig blok: 06:30–12:00 (10 min) | nog ~33 rondes
```

Per ronde:
```
[Village Agent] ── Ronde #1 | 08:30 | interval A: 10 min ──
[Village Agent] ✓ Ronde #1 | 6 dorpen | opgehaald: 🪵1350 🪨1350 🪙1350 | opslag: 🪵4200/8018 | 4.8s
[Village Agent] Volgende ophaling: 08:41:22 | nog ~32 rondes in dit blok
```

Bij sessie-herstel:
```
[Village Agent] Sessie verlopen — herlogin via Puppeteer...
[Puppeteer] ✓ 16 cookies opgeslagen
[Village Agent] Sessie hersteld! Snelle ronde over 1 minuut.
```

---

## Dagelijks rapport

Elke avond om 23u ontvang je een e-mail met de bot-status en je steden.
Bij CAPTCHA-detectie of mislukte login ontvang je direct een waarschuwingsmail.

---

## Anti-detectie maatregelen

- Log-normale jitter op farm-interval (menselijker dan uniform random)
- 10% kans op willekeurige extra pauze (5-10 min)
- 2% kans om een enkel dorp over te slaan per ronde
- User-Agent rotatie tussen Chrome versies
- Alleen actief tijdens geconfigureerde dagblokken
- Willekeurige vertraging (2-5s) tussen dorpen
