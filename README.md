# Grepolis Bot — Autofarm

Zelfgebouwde Grepolis autofarm bot die 24/7 draait op GitHub Actions. Geen open PC nodig.

---

## Projectstructuur

```
grepolis-bot/
├── config.json                  ← Alle instellingen (hoofdbestand)
├── cookies.json                 ← Wordt aangemaakt via GitHub Secret
├── package.json
├── .github/
│   └── workflows/
│       └── bot.yml              ← GitHub Actions workflow (elke 50 min)
└── src/
    ├── index.js                 ← Opstartpunt & herstart-logica
    ├── auth/
    │   └── session.js           ← Sessie & cookie-beheer
    ├── api/
    │   └── grepolis.js          ← Grepolis API-wrapper
    ├── modules/
    │   └── autofarm.js          ← Farm-logica, dagschema, statistieken
    └── utils/
        ├── logger.js            ← Logging (Belgische tijdzone)
        └── mailer.js            ← E-mailrapporten
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

- `world` — de server waar je speelt (bv. `nl133`)
- `player_id` — je speler-ID (zichtbaar in de game-URL)
- `towns` — lijst van steden; voeg extra steden toe als je er meerdere hebt. De coördinaten (`island_x`, `island_y`) en `id` vind je via F12 → Netwerk → een `farm_town_overviews` request → Payload tab.

### Dagschema

```json
"schedule": {
  "active_hours_morning": { "start_h": 6, "start_m": 30, "end_h": 12, "end_m": 0 },
  "active_hours_evening": { "start_h": 17, "start_m": 30, "end_h": 23, "end_m": 0 },
  "report_every_n_runs": 15,
  "slots": [
    {
      "hour_start": 6, "hour_end": 12,
      "options": [{ "time_option": 600, "weight": 100 }],
      "interval_minutes": 10,
      "jitter_minutes": 2
    }
  ],
  "extra_break": {
    "enabled": true,
    "chance": 0.10,
    "min_minutes": 5,
    "max_minutes": 10
  }
}
```

- `active_hours_morning/evening` — wanneer de bot actief is (halve uren worden ondersteund)
- `slots` — per tijdblok de farm-instellingen:
  - `time_option` — cooldown in seconden: `300`=5min, `600`=10min, `2400`=40min, `10800`=3u, `28800`=8u
  - `weight` — kans in % (meerdere opties mogelijk voor afwisseling)
  - `interval_minutes` — hoe vaak de bot farmt
  - `jitter_minutes` — willekeurige variatie op het interval (anti-detectie)
- `extra_break` — 10% kans op een extra pauze van 5-10 minuten (anti-detectie)
- `report_every_n_runs` — na hoeveel rondes een e-mailrapport verstuurd wordt

### Overige instellingen

```json
"captcha": { "pause_minutes": 45 },
"session": { "refresh_every_hours": 6 },
"email": { "enabled": true, "smtp_host": "smtp.gmail.com", "smtp_port": 587 }
```

- `captcha.pause_minutes` — hoe lang de bot pauzeert na een CAPTCHA-detectie
- `session.refresh_every_hours` — hoe vaak de sessie vernieuwd wordt
- `email.enabled` — zet op `false` om e-mails uit te schakelen

---

## GitHub Secrets instellen

Ga naar je repo → **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Inhoud |
|---|---|
| `GREPO_COOKIES` | Volledige inhoud van cookies.json (zie hieronder) |
| `GREPO_EMAIL` | Jouw Grepolis e-mailadres |
| `GREPO_PASSWORD` | Jouw Grepolis wachtwoord |
| `SMTP_USER` | Jouw Gmail-adres |
| `SMTP_PASS` | Gmail app-wachtwoord (zie hieronder) |
| `SMTP_TO` | E-mailadres voor rapporten |

### Gmail app-wachtwoord aanmaken
1. Ga naar [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Genereer een app-wachtwoord voor "Mail"
3. Gebruik de 16-cijferige code als `SMTP_PASS`

---

## Cookies exporteren

De bot heeft browsercookies nodig om in te loggen bij Grepolis.

**In Microsoft Edge:**
1. Installeer **Cookie-Editor** via de [Edge Add-ons store](https://microsoftedge.microsoft.com/addons/detail/cookie-editor/neaplmfkghagebokkhpjpoebhdledlfi)
2. Log in bij Grepolis en ga naar je game (bv. `nl133.grepolis.com/game/nl133`)
3. Klik op het Cookie-Editor icoontje → **Export** → **Export as JSON**
4. Ga naar GitHub → Settings → Secrets → `GREPO_COOKIES` → plak de inhoud

Cookies verlopen na enkele dagen tot weken. Je krijgt automatisch een e-mail als ze verlopen zijn.

---

## GitHub Actions (automatisch draaien)

De bot draait via GitHub Actions — volledig gratis, geen server nodig.

- De workflow start automatisch **elke 50 minuten**
- Elke instantie draait **45 minuten** en sluit daarna netjes af
- De volgende instantie start dan opnieuw op

De workflow staat in `.github/workflows/bot.yml`. Handmatig starten kan via **Actions → Grepolis Bot → Run workflow**.

---

## Logs begrijpen

Bij elke opstart:
```
Bot gestart | 22:13 | NL133
Actief slot: 17:00–23:00 | interval: ~10 min
Tijdopties: 10 min(100%)
Geschat nog ~4 rondes in dit blok
```

Per ronde:
```
── Ronde #1 | 22:13 | optie: 10 min ──
✓ Ronde #1 | 4 dorpen | opgehaald: 🪵680 🪨680 🪙680 | opslag: 🪵1240 🪨1076 🪙932/4165 | 6.5s
Cumulatief | 🪵680 🪨680 🪙680 | 1 rondes
Volgende ophaling: 22:30:48 | nog ~3 rondes in dit blok
```

- **opgehaald** — wat je in deze ronde opgehaald hebt
- **opslag** — wat er nu totaal in je opslagplek zit / maximale capaciteit
- **Cumulatief** — totaal opgehaald in deze sessie (reset per GitHub Actions instantie)

---

## E-mailrapporten

Na elke 15 rondes ontvang je een rapport met:
- Totaal opgehaalde grondstoffen (hout / steen / zilver)
- Gemiddeld per uur
- Overzicht van de laatste 5 rondes met opslagstand
- Uptime en foutenteller

Bij CAPTCHA-detectie of verlopen cookies ontvang je direct een waarschuwingsmail.

---

## Nieuwe stad toevoegen

1. Ga naar je nieuwe stad in Grepolis → open een boerendorp
2. F12 → Netwerk → filter XHR → zoek `farm_town_overviews?action=get_farm_towns_for_town`
3. Klik op de request → Payload → noteer `town_id`, `island_x`, `island_y`
4. Voeg toe aan `config.json` onder `towns`:
```json
{ "id": 1234, "name": "Nieuwe Stad", "island_x": 450, "island_y": 480 }
```

---

## Tijdopties per onderzoeksniveau

| Onderzoek | Beschikbare opties |
|---|---|
| Basis | 5 min, 20 min, 1u30, 4u |
| Na onderzoek | 10 min, 40 min, 3u, 8u |

Pas `time_option` in `config.json` aan op basis van welke onderzoeken je hebt afgerond.
