const logger = require("../utils/logger");

class Autofarm {
  constructor(api, config, mailer) {
    this.api      = api;
    this.config   = config;
    this.mailer   = mailer;
    this.running  = false;
    this.timer    = null;
    this.startTime = Date.now();
    this.roundNum  = 0;
    this.nextRunAt = null;
    this.stats     = this._emptyStats();
    this.history   = [];

    // Verwerk config naar intern formaat
    this.intervals = config.intervals;
    this.blokken   = this._parseBlokken(config.dagschema);
    this.opties    = config.opties ?? {};
  }

  _emptyStats() {
    return {
      runs: 0, failedRuns: 0,
      totalWood: 0, totalStone: 0, totalIron: 0,
      totalFarms: 0, byInterval: {}, lastReport: Date.now(),
    };
  }

  // Zet "06:30" om naar minuten sinds middernacht
  _timeToMins(str) {
    const [h, m] = str.split(":").map(Number);
    return h * 60 + m;
  }

  _parseBlokken(dagschema) {
    return dagschema.blokken.map(b => ({
      actief:  b.actief ?? true,
      vanMins: this._timeToMins(b.van),
      totMins: this._timeToMins(b.tot === "24:00" ? "23:59" : b.tot),
      interval: this.intervals[b.interval],
      naam: `${b.van}–${b.tot} (${this.intervals[b.interval]?.label})`,
      key: b.interval,
    }));
  }

  _nlTotalMins() {
    const now = new Date();
    const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
    const dst = now.getTimezoneOffset() < Math.max(jan, jul);
    return (now.getUTCHours() * 60 + now.getUTCMinutes() + (dst ? 120 : 60)) % 1440;
  }

  _nlTimeStr() {
    const t = this._nlTotalMins();
    return `${String(Math.floor(t/60)).padStart(2,"0")}:${String(t%60).padStart(2,"0")}`;
  }

  _isActive() {
    const blok = this._getCurrentBlok();
    return blok !== null; // actief als er een actief blok is
  }

  _getCurrentBlok() {
    const t = this._nlTotalMins();
    return this.blokken.find(b => b.actief && t >= b.vanMins && t < b.totMins) ?? null;
  }

  _estimateRondesLeft(blok) {
    if (!blok) return 0;
    const t = this._nlTotalMins();
    return Math.max(0, Math.floor((blok.totMins - t) / blok.interval.interval_minutes));
  }

  _calcDelay(blok) {
    // Minimumgrens = game cooldown (time_option) + 30 seconden buffer
    const minDelay = blok.interval.time_option * 1000 + 30_000;

    const base   = blok.interval.interval_minutes * 60 * 1000;
    // Jitter is altijd positief — we wachten nooit minder dan de cooldown
    const jitter = Math.random() * blok.interval.jitter_minutes * 60 * 1000;
    const kans   = this.opties.extra_pauze_kans ?? 0.10;
    const minMin = this.opties.extra_pauze_min_min ?? 5;
    const maxMin = this.opties.extra_pauze_max_min ?? 10;
    const extra  = Math.random() < kans
      ? (minMin + Math.random() * (maxMin - minMin)) * 60 * 1000 : 0;
    if (extra > 0) logger.info(`[Autofarm] Extra pauze ingebouwd (~${Math.round(extra/60000)} min)`);
    return Math.max(minDelay, base + jitter + extra);
  }

  start() {
    this.running = true;
    this._logOpstart();
    this.run();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    logger.info("[Autofarm] Gestopt.");
  }

  _logOpstart() {
    const blok   = this._getCurrentBlok();
    const actief = this._isActive();
    const schema = this.config.dagschema;

    logger.info(`[Autofarm] ═══════════════════════════════`);
    logger.info(`[Autofarm] Bot gestart | ${this._nlTimeStr()} | ${this.config.account.world.toUpperCase()}`);
    logger.info(`[Autofarm] Dagschema:`);
    schema.blokken.forEach(b => {
      const iv  = this.intervals[b.interval];
      const aan = b.actief ? "✓" : "✗";
      logger.info(`[Autofarm]   ${aan} ${b.van}–${b.tot} → ${b.interval} (${iv.label}, elke ~${iv.interval_minutes} min)`);
    });

    if (actief && blok) {
      logger.info(`[Autofarm] Huidig blok: ${blok.naam} | nog ~${this._estimateRondesLeft(blok)} rondes`);
    } else {
      logger.info(`[Autofarm] Buiten actieve uren.`);
    }
    logger.info(`[Autofarm] ═══════════════════════════════`);
  }

  _schedule(blok) {
    if (!this.running) return;
    if (!blok || !this._isActive()) {
      const wait = (15 + Math.random() * 10) * 60 * 1000;
      this.nextRunAt = new Date(Date.now() + wait);
      logger.info(`[Autofarm] Buiten actieve uren | volgende check: ${this.nextRunAt.toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels",hour:"2-digit",minute:"2-digit",second:"2-digit"})}`);
      this.timer = setTimeout(() => this.run(), wait);
      return;
    }
    const delay = this._calcDelay(blok);
    this.nextRunAt = new Date(Date.now() + delay);
    const rondesLeft = this._estimateRondesLeft(blok);
    logger.info(`[Autofarm] Volgende ophaling: ${this.nextRunAt.toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels",hour:"2-digit",minute:"2-digit",second:"2-digit"})} | nog ~${rondesLeft} rondes in dit blok`);
    this.timer = setTimeout(() => this.run(), delay);
  }

  async run() {
    if (!this.running) return;
    const blok = this._getCurrentBlok();
    if (!this._isActive() || !blok) { this._schedule(null); return; }

    const roundStart = Date.now();
    this.roundNum++;
    this.stats.runs++;
    const label = `${blok.key} (${blok.interval.label})`;

    logger.info(`[Autofarm] ── Ronde #${this.roundNum} | ${this._nlTimeStr()} | interval ${blok.key}: ${blok.interval.label} ──`);

    let wood = 0, stone = 0, iron = 0, farms = 0, lastStorage = null;

    try {
      const towns = await this.api.getTowns();
      for (const town of towns) {
        const r = await this._farmTown(town, blok.interval.time_option);
        if (r) {
          wood  += r.wood  ?? 0;
          stone += r.stone ?? 0;
          iron  += r.iron  ?? 0;
          farms += r.farms ?? 0;
          if (r.storageWood !== undefined) lastStorage = r;
          await this._sleep(2000 + Math.random() * 3000);
        }
      }

      this.stats.totalWood  += wood;
      this.stats.totalStone += stone;
      this.stats.totalIron  += iron;
      this.stats.totalFarms += farms;
      this.stats.byInterval[label] = (this.stats.byInterval[label] ?? 0) + 1;

      const dur = ((Date.now() - roundStart) / 1000).toFixed(1);

      this.history.push({
        time: this._nlTimeStr(), label, wood, stone, iron, farms,
        storageWood:  lastStorage?.storageWood  ?? 0,
        storageStone: lastStorage?.storageStone ?? 0,
        storageIron:  lastStorage?.storageIron  ?? 0,
        storageMax:   lastStorage?.storageMax   ?? 0,
        duration: dur, roundNum: this.roundNum,
      });
      if (this.history.length > 50) this.history.shift();

      if (farms > 0) {
        const opslag = lastStorage
          ? ` | opslag: 🪵${lastStorage.storageWood} 🪨${lastStorage.storageStone} 🪙${lastStorage.storageIron}/${lastStorage.storageMax}`
          : "";
        logger.info(`[Autofarm] ✓ Ronde #${this.roundNum} | ${farms} dorpen | opgehaald: 🪵${wood} 🪨${stone} 🪙${iron}${opslag} | ${dur}s`);
        logger.info(`[Autofarm] Cumulatief | 🪵${this.stats.totalWood} 🪨${this.stats.totalStone} 🪙${this.stats.totalIron} | ${this.stats.runs} rondes`);
      } else {
        logger.info(`[Autofarm] Ronde #${this.roundNum} | niets te halen | ${dur}s`);
      }

      const rapportN = this.opties.rapport_elke_n_rondes ?? 999;
      if (this.stats.runs % rapportN === 0) {
        await this._sendReport();
      }

    } catch (err) {
      if (err.message === "SESSION_EXPIRED") {
        logger.warn(`[Autofarm] Sessie verlopen (GSM-login?), probeer te herverbinden...`);
        try {
          // Stap 1: Probeer gewoon de CSRF token te vernieuwen (snel)
          const csrfOk = await this.api.session.refreshCsrf();
          if (csrfOk) {
            logger.info(`[Autofarm] CSRF vernieuwd — sessie hersteld!`);
          } else {
            // Stap 2: Volledige herlogin via Puppeteer
            logger.info(`[Autofarm] CSRF mislukt, volledige herlogin starten...`);
            await this.api.session.login();
            logger.info(`[Autofarm] Sessie volledig vernieuwd via Puppeteer!`);
          }
        } catch (loginErr) {
          logger.error(`[Autofarm] Herverbinden mislukt: ${loginErr.message}`);
          this.stats.failedRuns++;
        }
      } else {
        this.stats.failedRuns++;
        logger.error(`[Autofarm] Fout ronde #${this.roundNum}: ${err.message}`);
        await this._handleCaptcha(err.message);
      }
    }

    this._schedule(blok);
  }

  async _farmTown(town, timeOption) {
    try {
      const { ready, owned } = await this.api.getFarmOverview(town);
      if (ready.length === 0) { logger.info(`[Autofarm]   ${town.name}: niets klaar`); return null; }
      await this._sleep(400 + Math.random() * 800);
      const result = await this.api.claimLoads(town, owned.map(v => v.id), timeOption);
      if (result) return { ...result, farms: ready.length };
    } catch (err) {
      if (err.message === "SESSION_EXPIRED") {
        logger.warn(`[Autofarm]   Sessie verlopen tijdens farm — automatisch herverbinden...`);
        throw err; // Gooi door zodat run() het oppakt
      }
      logger.error(`[Autofarm]   Fout bij ${town.name}: ${err.message}`);
      throw err;
    }
    return null;
  }

  async _handleCaptcha(message) {
    if (!message?.toLowerCase().match(/captcha|robot|verificat|beveil/)) return;
    logger.error("[Autofarm] 🚨 CAPTCHA gedetecteerd!");
    if (!global._captchaMailSent) {
      global._captchaMailSent = true;
      const pauze = this.opties.captcha_pauze_min ?? 45;
      await this.mailer.send(
        "🚨 CAPTCHA gedetecteerd — actie vereist!",
        `Tijdstip: ${new Date().toLocaleString("nl-BE")}\nWereld: ${this.config.account.world.toUpperCase()}\n\nLos de CAPTCHA op in je browser.\nDe bot herstart automatisch na ${pauze} minuten.`
      );
    }
    this.stop();
    setTimeout(() => { this.start(); }, (this.opties.captcha_pauze_min ?? 45) * 60 * 1000);
  }

  async _sendReport() {
    const elapsed = Math.round((Date.now() - this.stats.lastReport) / 60000);
    const totaal  = this.stats.totalWood + this.stats.totalStone + this.stats.totalIron;
    const perUur  = elapsed > 0 ? Math.round(totaal / elapsed * 60) : 0;
    const uptime  = Math.round((Date.now() - this.startTime) / 60000);

    const recentRondes = this.history.slice(-5).reverse().map(r => {
      const opslag = r.storageMax > 0
        ? ` | opslag: 🪵${r.storageWood} 🪨${r.storageStone} 🪙${r.storageIron}/${r.storageMax}`
        : "";
      return `  #${String(r.roundNum).padStart(3)} | ${r.time} | ${r.label.padEnd(8)} | 🪵${String(r.wood).padStart(4)} 🪨${String(r.stone).padStart(4)} 🪙${String(r.iron).padStart(4)}${opslag}`;
    }).join("\n");

    const text = [
      `📊 FARM RAPPORT — ${new Date().toLocaleString("nl-BE")}`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📈 SAMENVATTING (${this.stats.runs} rondes, ~${elapsed} min)`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `  🪵 Hout:    ${this.stats.totalWood.toLocaleString("nl-BE")}`,
      `  🪨 Steen:   ${this.stats.totalStone.toLocaleString("nl-BE")}`,
      `  🪙 Zilver:  ${this.stats.totalIron.toLocaleString("nl-BE")}`,
      `  📦 Totaal:  ${totaal.toLocaleString("nl-BE")}`,
      `  ⚡ Per uur:  ~${perUur.toLocaleString("nl-BE")}`,
      `  🏘️  Dorpen:   ${this.stats.totalFarms} beurten`,
      `  ❌ Fouten:   ${this.stats.failedRuns}`,
      `  ⏱️  Uptime:   ${uptime} min`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🕐 LAATSTE 5 RONDES`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      recentRondes || "  Geen rondes beschikbaar.",
      ``,
      `Bot draait normaal ✅`,
    ].join("\n");

    await this.mailer.send(`📊 Rapport — ${totaal.toLocaleString("nl-BE")} grondstoffen`, text);
    this.stats = this._emptyStats();
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = Autofarm;
