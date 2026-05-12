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
    │   └── grepolis.js                ← API wrapper (farm, gebouwen, handel, ...)
    ├── modules/
    │   ├── village-agent.js           ← Orchestrator: hoofdloop, sessie, timing
    │   ├── farm-agent.js              ← Farm Balancer + opslagcheck + claim logica
    │   ├── data-collector.js          ← Snapshots: gebouwen, goden, grotten, troepen
    │   └── resource-balancer.js       ← Interne grondstofverdeling tussen steden
    └── utils/
        ├── logger.js                  ← Winston, Europe/Brussels tijdzone
        ├── mailer.js                  ← E-mailrapporten
        └── stats-writer.js            ← GAS Dashboard communicatie
```

---

## Architectuur

De bot is opgebouwd als een orchestrator met drie sub-agents:

```
VillageAgent (orchestrator)
  │
  ├── DataCollector    — ronde 1 of GAS trigger
  │     gebouwen / goden / grotten / troepen
  │
  ├── ResourceBalancer — elke ronde
  │     interne handel: surplus → tekort, stadsfeest-voorbereiding
  │
  └── FarmAgent        — elke ronde
        farm balancer (welke stad per eiland) + claim farms
```

### Workflow per ronde

```
getTowns() → saveTowns() → syncEilanden()
  → DataCollector.run()       (enkel ronde 1 / GAS trigger)
  → ResourceBalancer.run()    (elke ronde)
  → FarmAgent.run()           (elke ronde)
  → saveRound() → schedule()
```

---

## Configuratie (config.json)

Dit is het enige bestand dat je normaal hoeft aan te passen. Wijzigingen zijn ook via het GAS Dashboard te maken.

### Account

```json
"account": {
  "world": "nlXXX",
  "player_id": 0,
  "towns": []
}
```

Steden worden automatisch herkend uit de gamepagina via `farm_town_overviews`.

### Dagschema

```json
"intervals": {
  "A": { "label": "10 min", "interval_minutes": 10, "jitter_minutes": 2 },
  "B": { "label": "40 min", "interval_minutes": 40, "jitter_minutes": 5 },
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

### Eilanden & Farm Balancer

```json
"eilanden": {
  "475_503": {
    "naam": "Eilandnaam",
    "primaire_stad_id": 329
  }
},
"opties": {
  "balancer": true,
  "balancer_drempel_pct": 80
}
```

De **Farm Balancer** schakelt automatisch naar een alternatieve stad op hetzelfde eiland wanneer de primaire stad ≥2 grondstoffen boven de drempel heeft.

### Resource Balancer

```json
"resource_balancer": {
  "enabled": false,
  "preview": true,
  "modus": "balans",
  "balans": {
    "surplus_drempel": 85,
    "tekort_drempel": 30,
    "min_transfer": 1000,
    "max_transfers_per_ronde": 3
  },
  "stadsfeest": {
    "enabled": false,
    "doel_stad_id": null,
    "aantal": 1
  }
}
```

**Modus `balans`**: verzendt grondstoffen van steden met surplus (>85%) naar steden met tekort (<30%), rekening houdend met beschikbare handelskapaciteit.

**Modus `stadsfeest`**: verzamelt 15k hout + 18k steen + 15k zilver per feest in de gekozen doel-stad. Vereist academie niveau ≥30 in de doel-stad.

**Preview-modus** (`preview: true`): logt wat de balancer zou doen zonder echte transfers. Zet op `false` om live te gaan.

### Opties

| Optie | Standaard | Beschrijving |
|---|---|---|
| `extra_pauze_kans` | 0.10 | Kans op willekeurige extra pauze per ronde |
| `opslag_drempel_pct` | 95 | Opslagdrempel waarboven claimen wordt overgeslagen |
| `cooldown_snap_min` | 4 | Wacht op cooldown als die binnen X min valt |
| `uitgebouwd_punten` | 20000 | Drempel voor "uitgebouwde" stad in dashboard |
| `balancer` | true | Farm Balancer aan/uit |
| `balancer_drempel_pct` | 80 | Drempel voor Farm Balancer wisseling |

---

## GitHub Secrets instellen

Ga naar repo → **Settings → Secrets → Actions → New repository secret**

| Secret | Inhoud |
|---|---|
| `GREPO_EMAIL` | Jouw Grepolis e-mailadres |
| `GREPO_PASSWORD` | Jouw Grepolis wachtwoord |
| `GREPO_COOKIES` | Cookie-Editor JSON export |
| `GREPO_ACCOUNT` | `{"world":"nlXXX","player_id":0}` |
| `GAS_URL` | Deployment URL van het GAS dashboard |
| `GAS_SECRET` | Geheime sleutel voor GAS-authenticatie |
| `GH_PAT` | GitHub Personal Access Token (voor config sync) |
| `SMTP_USER` | Gmail-adres voor rapporten |
| `SMTP_PASS` | Gmail app-wachtwoord (16 tekens) |
| `SMTP_TO` | Bestemmingsadres rapporten |

### Gmail app-wachtwoord aanmaken
1. Ga naar [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Genereer een app-wachtwoord voor "Mail"
3. Gebruik de 16-cijferige code als `SMTP_PASS`

---

## Login flow

1. **Bestaande cookies** (`GREPO_COOKIES`) — snel, geen browser nodig
2. **Puppeteer fallback** — logt automatisch in via de game-website

Bij sessie-verlies herstart de bot automatisch (max 1 herstelpoging per sessie).

---

## Cookies exporteren

1. Installeer **Cookie-Editor** ([Edge](https://microsoftedge.microsoft.com/addons/detail/cookie-editor/neaplmfkghagebokkhpjpoebhdledlfi) of [Chrome](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm))
2. Log in bij Grepolis en ga naar je game
3. Klik op Cookie-Editor → **Export** → **Export as JSON**
4. Plak de inhoud in het `GREPO_COOKIES` secret op GitHub

---

## GAS Dashboard

### Tabs

| Tab | Inhoud |
|---|---|
| 🏠 **Home** | Status, KPI-kaarten, steden grid |
| 🌾 **Farm Agent** | Overzicht · Harvest queue · Dagschema · Steden |
| 🏛️ **Economie** | Gebouwentabel · Resource Balancer |
| ⚔️ **Militair** | Troepenoverzicht (Off/Def/Totaal) · Rekrutering |
| ⚙️ **Config** | Alle instellingen bewerkbaar, opslaan naar GitHub |

### Economie → Resource Balancer tab

Toont de actuele configuratie, actieve modus en de transfer-log van recente runs. Modus en preview/live zijn hier wisselbaar zonder config te pushen.

### Militair → Troepen

- Toggle **Off / Def / Totaal** voor KPI-kaarten land/zee
- Hover-tooltips per eenheidstype
- Δ 24u kaart op basis van automatisch opgebouwde historiek (na 20u)

### Militair → Rekrutering

- Alle actieve orders per stad (kazerne + haven)
- Filter op stad (trechter) of eenheidstype (dropdown)
- Voortgangsbalk + ETA per order

### GAS Script Properties

Via Apps Script → Project instellingen → Script properties:

| Property | Waarde |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT |
| `GITHUB_REPO` | `gebruiker/grepo-toolkit` |
| `BOT_SECRET` | Geheime sleutel (= `GAS_SECRET`) |
| `ALLOWED_EMAIL` | Jouw Google-account e-mail |
| `SPREADSHEET_ID` | Google Sheets ID |

---

## Google Sheets structuur

| Sheet | Inhoud |
|---|---|
| `Sessions` | Per sessie: timing, grondstoffen, reden afsluiting |
| `Rounds` | Per ronde: interval, farms, grondstoffen |
| `TownSnapshots` | Stadsresources na elke claim |
| `Towns` | Actuele stadsdata (28 kolommen incl. god, grot) |
| `Buildings` | Gebouwniveaus per stad (47 kolommen) |
| `TroopsData` | Troepen JSON + vorige snapshot voor Δ 24u (6 kolommen) |
| `TradeLog` | Resource Balancer transfer-log (laatste 20 runs) |
| `HarvestQueue` | Handmatige harvest-taken |
| `Status` | Bot-status (19 kolommen) |

> **Let op:** Maak TroopsData leeg na een schema-update. De Δ 24u historiek bouwt automatisch op na de eerste run.

---

## Automatisch draaien

- **GitHub Actions cron**: elke 50 minuten
- **cron-job.org**: externe trigger als backup
- **Keepalive**: elke 6 uur lege commit
- **Concurrency**: nooit meer dan één instantie tegelijk

Handmatig starten: **Actions → Grepo Toolkit — Village Agent → Run workflow**

---

## Logs begrijpen

```
── Ronde #1 | 08:30 | A ──
[Data] Data-collectie starten...
[Resource Balancer] PREVIEW 🔄 02A.Polo → 01A.Marco: 10.000 🪵
[Farm] 🔄 Farm Balancer 475_503: 01A.Marco (92/88/85%) → 01B.Vasco (30/25/20%)
[Farm] 01B.Vasco: 🪵34% 🪨28% 🪙31%
[Sessie] ✓ #1 | 6 drp | 🪵1.350 🪨1.350 🪙1.350 | cum: 🪵1.350 🪨1.350 🪙1.350
[Sessie] Volgende ophaling: 08:41:22 | nog ~32 rondes
```

---

## Anti-detectie maatregelen

- Log-normale jitter op farm-interval (menselijker dan uniform random)
- 10% kans op willekeurige extra pauze (5–10 min)
- 2% kans om een enkel dorp over te slaan per ronde
- Willekeurige vertraging (400–800ms) tussen dorpen
- Alleen actief tijdens geconfigureerde dagblokken
- Altijd sequentieel — nooit parallelle requests
