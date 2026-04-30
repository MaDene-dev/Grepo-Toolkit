name: Grepo Toolkit — Daily Report

on:
  schedule:
    - cron: "0 21 * * *"
  workflow_dispatch:

jobs:
  daily-report:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "24"

      - name: Install dependencies
        run: npm install --omit=dev

      - name: Write cookies
        run: |
          if [ -n "$GREPO_COOKIES" ]; then
            echo "$GREPO_COOKIES" > cookies.json
          fi
        env:
          GREPO_COOKIES: ${{ secrets.GREPO_COOKIES }}

      - name: Send daily report
        env:
          GREPO_EMAIL:          ${{ secrets.GREPO_EMAIL }}
          GREPO_PASSWORD:       ${{ secrets.GREPO_PASSWORD }}
          SMTP_USER:            ${{ secrets.SMTP_USER }}
          SMTP_PASS:            ${{ secrets.SMTP_PASS }}
          SMTP_TO:              ${{ secrets.SMTP_TO }}
          DAILY_REPORT:         "true"
        run: node src/daily-report.js
