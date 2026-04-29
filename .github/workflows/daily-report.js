name: Dagelijks Rapport

on:
  schedule:
    - cron: "0 21 * * *"  # 23:00 Belgische tijd (UTC+2 zomer)
  workflow_dispatch:

jobs:
  daily-report:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Code ophalen
        uses: actions/checkout@v4

      - name: Node.js instellen
        uses: actions/setup-node@v4
        with:
          node-version: "24"

      - name: Dependencies installeren
        run: npm install --omit=dev

      - name: Cookies wegschrijven
        run: echo '${{ secrets.GREPO_COOKIES }}' > cookies.json

      - name: Dagrapport versturen
        env:
          GREPO_EMAIL:    ${{ secrets.GREPO_EMAIL }}
          GREPO_PASSWORD: ${{ secrets.GREPO_PASSWORD }}
          SMTP_USER:      ${{ secrets.SMTP_USER }}
          SMTP_PASS:      ${{ secrets.SMTP_PASS }}
          SMTP_TO:        ${{ secrets.SMTP_TO }}
          DAILY_REPORT:   "true"
        run: node src/daily-report.js
