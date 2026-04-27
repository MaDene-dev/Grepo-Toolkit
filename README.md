# Grepolis Bot — Autofarm

Zelfgehoste Grepolis bot die server-side draait. Geen browser, geen open PC nodig.

## Vereisten

- Node.js v18 of hoger
- Een VPS of gratis cloudplatform (zie Deployment)

## Installatie

```bash
npm install
```

## Configuratie

Pas `config.json` aan:

```json
{
  "account": {
    "username": "JOUW_EMAIL",
    "password": "JOUW_WACHTWOORD",
    "world":    "nl77"
  },
  "autofarm": {
    "enabled": true,
    "mode": "loot",
    "interval_minutes": 30,
    "randomize_interval": true,
    "randomize_range_minutes": 5
  }
}
```

| Optie | Uitleg |
|---|---|
| `world` | De server waar je speelt, bv. `nl77`, `nl82` |
| `mode` | `"loot"` (plunderen) of `"demand"` (eisen) |
| `interval_minutes` | Hoe vaak je farmt (in minuten) |
| `randomize_interval` | Voegt willekeurige variatie toe (anti-detectie) |
| `randomize_range_minutes` | Hoeveel minuten variatie (±) |

## Draaien

```bash
node src/index.js
```

Logs worden opgeslagen in `bot.log`.

---

## Deployment (zonder open PC)

### Optie 1 — Railway (gratis, makkelijkst)

1. Maak een account op [railway.app](https://railway.app)
2. Klik op "New Project" → "Deploy from GitHub"
3. Push deze code naar een GitHub repo
4. Voeg de config-waarden toe als **Environment Variables** in Railway
5. Done — de bot draait 24/7 in de cloud

### Optie 2 — VPS (€3-5/maand, meest controle)

Elke goedkope VPS werkt (Hetzner, DigitalOcean, Contabo).

```bash
# Installeer Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# Kopieer bestanden naar VPS, dan:
npm install

# Draai permanent met PM2
npm install -g pm2
pm2 start src/index.js --name grepolis-bot
pm2 save
pm2 startup
```

### Optie 3 — Render (gratis tier)

1. Maak account op [render.com](https://render.com)
2. New → Background Worker → connect je GitHub repo
3. Start command: `node src/index.js`

---

## Projectstructuur

```
grepolis-bot/
├── config.json              ← Jouw instellingen
├── src/
│   ├── index.js             ← Entry point & herstart-logica
│   ├── auth/
│   │   └── session.js       ← Login & sessie-beheer
│   ├── api/
│   │   └── grepolis.js      ← API-wrapper (steden, villages, farm-calls)
│   ├── modules/
│   │   └── autofarm.js      ← Farm-logica & cooldown-tracking
│   └── utils/
│       └── logger.js        ← Logging naar console + bestand
└── bot.log                  ← Automatisch aangemaakt
```

## Volgende modules (gepland)

- [ ] Autobuild — gebouwen automatisch bouwen
- [ ] Autoculture — cultuur-events automatiseren
- [ ] Autoattack — aanvallen plannen
- [ ] Webinterface — bot beheren vanuit je browser
