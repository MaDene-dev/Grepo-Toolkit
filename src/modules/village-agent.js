const logger = require("../utils/logger");

class VillageAgent {
  constructor(api, config, mailer, stats = null) {
    this.api      = api;
    this.config   = config;
    this.mailer       = mailer;
    this.stats_writer = stats;
    this.running  = false;
    this.timer    = null;
    this.startTime = Date.now();
    this.roundNum  = 0;
    this.nextRunAt = null;
    this.stats     = this._emptyStats();
    this.history   = [];
    this._recovering = false;

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
    // Gebruik Intl voor betrouwbare Belgische tijdzone (automatisch zomer/wintertijd)
    const now = new Date();
    const parts = new Intl.DateTimeFormat("nl-BE", {
      timeZone: "Europe/Brussels",
      hour: "numeric", minute: "numeric", hour12: false,
    }).formatToParts(now);
    const h = parseInt(parts.find(p => p.type === "hour").value);
    const m = parseInt(parts.find(p => p.type === "minute").value);
    return h * 60 + m;
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
    const minDelay = blok.interval.time_option * 1000 + 30_000;
    const base     = blok.interval.interval_minutes * 60 * 1000;

    // Log-normaal verdeelde jitter — menselijker dan uniform random
    // Mensen reageren vaker iets te laat dan veel te vroeg
    const u1 = Math.random(), u2 = Math.random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const jitter = Math.abs(normal) * blok.interval.jitter_minutes * 60 * 1000;

    const kans   = this.opties.extra_pauze_kans ?? 0.10;
    const minMin = this.opties.extra_pauze_min_min ?? 5;
    const maxMin = this.opties.extra_pauze_max_min ?? 10;
    const extra  = Math.random() < kans
      ? (minMin + Math.random() * (maxMin - minMin)) * 60 * 1000 : 0;
    if (extra > 0) logger.info(`[Village Agent] Extra pauze ingebouwd (~${Math.round(extra/60000)} min)`);
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
    logger.info("[Village Agent] Gestopt.");
  }

  _logOpstart() {
    const blok   = this._getCurrentBlok();
    const actief = this._isActive();
    const schema = this.config.dagschema;

    logger.info(`[Village Agent] ═══════════════════════════════`);
    logger.info(`[Village Agent] Bot gestart | ${this._nlTimeStr()} | ${this.config.account.world.toUpperCase()}`);
    logger.info(`[Village Agent] Dagschema:`);
    schema.blokken.forEach(b => {
      const iv  = this.intervals[b.interval];
      const aan = b.actief ? "✓" : "✗";
      logger.info(`[Village Agent]   ${aan} ${b.van}–${b.tot} → ${b.interval} (${iv.label}, elke ~${iv.interval_minutes} min)`);
    });

    if (actief && blok) {
      logger.info(`[Village Agent] Huidig blok: ${blok.naam} | nog ~${this._estimateRondesLeft(blok)} rondes`);
    } else {
      logger.info(`[Village Agent] Buiten actieve uren.`);
    }
    logger.info(`[Village Agent] ═══════════════════════════════`);
  }

  _schedule(blok, farms = 0) {
    if (!this.running) return;
    if (!blok || !this._isActive()) {
      const wait = (15 + Math.random() * 10) * 60 * 1000;
      this.nextRunAt = new Date(Date.now() + wait);
      logger.info(`[Village Agent] Buiten actieve uren | volgende check: ${this.nextRunAt.toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels",hour:"2-digit",minute:"2-digit",second:"2-digit"})}`);
      this.timer = setTimeout(() => this.run(), wait);
      return;
    }
    let delay = this._calcDelay(blok);

    // Als alle dorpen in cooldown zijn maar de cooldown binnen 4 min voorbij is:
    // Plan de volgende ronde op dat exacte moment
    if (this._nextReadyAt && farms === 0) {
      const now = Date.now();
      const cooldownMs = (this._nextReadyAt * 1000) - now;
      if (cooldownMs > 0 && cooldownMs < 4 * 60 * 1000) {
        const cooldownSecs = Math.ceil(cooldownMs / 1000);
        logger.info(`[Village Agent] Dorpen in cooldown — volgende ophaling over ${cooldownSecs}s (cooldown loopt af)`);
        delay = cooldownMs + 5000; // 5 seconden buffer na cooldown
      }
    }
    this._nextReadyAt = null; // Reset voor volgende ronde

    this.nextRunAt = new Date(Date.now() + delay);
    const rondesLeft = this._estimateRondesLeft(blok);

    // Controleer of de volgende run binnen de GitHub Actions auto-stop valt
    if (this.autoStopAt && this.nextRunAt >= this.autoStopAt) {
      logger.info(`[Village Agent] Volgende ophaling (${this.nextRunAt.toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels",hour:"2-digit",minute:"2-digit"})}) valt na auto-stop — netjes afsluiten.`);
      this.stop();
      process.exit(0);
      return;
    }

    logger.info(`[Village Agent] Volgende ophaling: ${this.nextRunAt.toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels",hour:"2-digit",minute:"2-digit",second:"2-digit"})} | nog ~${rondesLeft} rondes in dit blok`);
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

    logger.info(`[Village Agent] ── Ronde #${this.roundNum} | ${this._nlTimeStr()} | interval ${blok.key}: ${blok.interval.label} ──`);

    let wood = 0, stone = 0, iron = 0, farms = 0, lastStorage = null;

    try {
      const towns = await this.api.getTowns();
      const overview = await this._farmAllTowns(towns, blok.key);
      wood  = overview.wood  ?? 0;
      stone = overview.stone ?? 0;
      iron  = overview.iron  ?? 0;
      farms = overview.farms ?? 0;
      if (overview.storageWood !== undefined) lastStorage = overview;

      this.stats.totalWood  += wood;
      this.stats.totalStone += stone;
      this.stats.totalIron  += iron;
      this.stats.totalFarms += farms;
      this.stats.byInterval[label] = (this.stats.byInterval[label] ?? 0) + 1;

      const dur = ((Date.now() - roundStart) / 1000).toFixed(1);

      this.history.push({
        time: this._nlTimeStr(), label, wood, stone, silver: iron, farms,
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
        logger.info(`[Village Agent] ✓ Ronde #${this.roundNum} | ${farms} dorpen | opgehaald: 🪵${wood} 🪨${stone} 🪙${iron}${opslag} | ${dur}s`);
        logger.info(`[Village Agent] Cumulatief | 🪵${this.stats.totalWood} 🪨${this.stats.totalStone} 🪙${this.stats.totalIron} | ${this.stats.runs} rondes`);
      } else {
        logger.info(`[Village Agent] Ronde #${this.roundNum} | niets te halen | ${dur}s`);
      }

      // Stuur stats naar dashboard na elke ronde (ook als er niets te halen was)
      if (this.stats_writer) {
        await this.stats_writer.recordSession(this.stats, this.history);
      }

      const rapportN = this.opties.rapport_elke_n_rondes ?? 999;
      if (this.stats.runs % rapportN === 0) {
        await this._sendReport();
      }

    } catch (err) {
      if (err.message === "SESSION_EXPIRED") {
        // Ronde was niet uitgevoerd — tel hem niet mee
        this.roundNum--;
        this.stats.runs--;

        if (this._recovering) {
          logger.error(`[Village Agent] Herstel mislukt — volgende ronde ingepland.`);
          this._recovering = false;
          this.stats.failedRuns++;
        } else {
          this._recovering = true;
          logger.warn(`[Village Agent] Sessie verlopen — herlogin via Puppeteer...`);
          let herstelOk = false;
          try {
            await this.api.session.login();
            this.api.resetTowns(); // Reset town cache na sessie-herstel
            herstelOk = true;
            logger.info(`[Village Agent] Sessie hersteld!`);
          } catch (loginErr) {
            logger.error(`[Village Agent] Herverbinden mislukt: ${loginErr.message}`);
            this.stats.failedRuns++;
          }
          this._recovering = false;

          if (herstelOk) {
            logger.info(`[Village Agent] Snelle ronde ingepland over 30 seconden.`);
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => this.run(), 30_000);
            return;
          }
        }
      } else {
        this.stats.failedRuns++;
        logger.error(`[Village Agent] Fout ronde #${this.roundNum}: ${err.message}`);
        await this._handleCaptcha(err.message);
      }
    }

    this._schedule(blok, farms);
  }

  async _farmAllTowns(towns, intervalKey) {
    // Haal farm overview per stad op (bewezen werkende aanpak)
    // Verzamel alle klare dorpen over alle steden
    let allOwned = [], allReady = [], earliestCooldown = null;

    for (const town of towns) {
      try {
        const { owned, ready, nextReady } = await this.api.getFarmOverview(town);
        allOwned.push(...owned);
        allReady.push(...ready);
        if (nextReady) earliestCooldown = Math.min(earliestCooldown ?? Infinity, nextReady);
        await this._sleep(500 + Math.random() * 500);
      } catch (err) {
        if (err.message === "SESSION_EXPIRED") throw err;
        logger.warn(`[Village Agent]   ${town.name} overgeslagen: ${err.message}`);
      }
    }

    if (allReady.length === 0) {
      if (earliestCooldown) this._nextReadyAt = earliestCooldown;
      logger.info(`[Village Agent]   Geen dorpen klaar`);
      return { wood:0, stone:0, iron:0, farms:0 };
    }

    // Sla occasioneel een enkel dorp over — menselijk gedrag (2% kans)
    const filtered = allOwned.filter(() => Math.random() > 0.02);
    if (filtered.length === 0) {
      logger.info(`[Village Agent]   Overgeslagen (menselijk gedrag)`);
      return { wood:0, stone:0, iron:0, farms:0 };
    }

    await this._sleep(400 + Math.random() * 800);

    // Claim voor alle steden in één call
    const result = await this.api.claimLoads(towns, filtered.map(v => v.id), intervalKey);
    if (result) return { ...result, farms: allReady.length };

    return { wood:0, stone:0, iron:0, farms:0 };
  }

  async _handleCaptcha(message) {
    if (!message?.toLowerCase().match(/captcha|robot|verificat|beveil/)) return;
    logger.error("[Village Agent] 🚨 CAPTCHA gedetecteerd!");
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

module.exports = VillageAgent;
