const logger = require("../utils/logger");

const TIME_LABELS = {
  300: "5 min", 600: "10 min", 1200: "20 min", 2400: "40 min",
  5400: "1u30", 10800: "3u", 14400: "4u", 28800: "8u",
};

class Autofarm {
  constructor(api, config, mailer) {
    this.api      = api;
    this.config   = config;
    this.mailer   = mailer;
    this.schedule = config.schedule;
    this.world    = config.account.world;
    this.running  = false;
    this.timer    = null;
    this.startTime = Date.now();

    // Stats per rapport-periode
    this.stats = this._emptyStats();
    // Historiek per ronde voor gedetailleerde rapportage
    this.history = [];
  }

  _emptyStats() {
    return {
      runs: 0, failedRuns: 0,
      totalWood: 0, totalStone: 0, totalIron: 0,
      totalFarms: 0,
      byTimeOption: {},
      lastReport: Date.now(),
    };
  }

  start() {
    logger.info("[Autofarm] Gestart — eerste ronde begint direct.");
    this.running = true;
    this.run();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    logger.info("[Autofarm] Gestopt.");
  }

  _nlTime() {
    const now = new Date();
    const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
    const dst = now.getTimezoneOffset() < Math.max(jan, jul);
    const totalMins = (now.getUTCHours() * 60 + now.getUTCMinutes() + (dst ? 120 : 60)) % 1440;
    return { h: Math.floor(totalMins / 60), m: totalMins % 60, totalMins };
  }

  _isActiveHour() {
    const { totalMins } = this._nlTime();
    const schedule = this.schedule;

    // Ochtendblok
    if (schedule.active_hours_morning) {
      const { start_h, start_m, end_h, end_m } = schedule.active_hours_morning;
      const start = start_h * 60 + start_m;
      const end   = end_h   * 60 + end_m;
      if (totalMins >= start && totalMins < end) return true;
    }

    // Avondblok
    if (schedule.active_hours_evening) {
      const { start_h, start_m, end_h, end_m } = schedule.active_hours_evening;
      const start = start_h * 60 + start_m;
      const end   = end_h   * 60 + end_m;
      if (totalMins >= start && totalMins < end) return true;
    }

    // Fallback: oud formaat
    if (schedule.active_hours) {
      const { h } = this._nlTime();
      return h >= schedule.active_hours.start && h < schedule.active_hours.end;
    }

    return false;
  }

  _getCurrentSlot() {
    const { h } = this._nlTime();
    return this.schedule.slots.find(s => h >= s.hour_start && h < s.hour_end) ?? null;
  }

  _pickTimeOption(slot) {
    const total = slot.options.reduce((s, o) => s + o.weight, 0);
    let rand = Math.random() * total;
    for (const opt of slot.options) {
      rand -= opt.weight;
      if (rand <= 0) return opt.time_option;
    }
    return slot.options[slot.options.length - 1].time_option;
  }

  _calcDelay(slot) {
    const base   = slot.interval_minutes * 60 * 1000;
    const jitter = (Math.random() * 2 - 1) * slot.jitter_minutes * 60 * 1000;
    const extra  = Math.random() < 0.10 ? (5 + Math.random() * 10) * 60 * 1000 : 0;
    if (extra > 0) logger.info(`[Autofarm] Extra pauze ingebouwd (~${Math.round(extra/60000)} min).`);
    return Math.max(60_000, base + jitter + extra);
  }

  _schedule(slot) {
    if (!this.running) return;
    if (!slot || !this._isActiveHour()) {
      const wait = (15 + Math.random() * 10) * 60 * 1000;
      logger.info(`[Autofarm] Buiten actieve uren. Check over ${Math.round(wait/60000)} min.`);
      this.timer = setTimeout(() => this.run(), wait);
      return;
    }
    const delay = this._calcDelay(slot);
    logger.info(`[Autofarm] Volgende ronde over ${Math.round(delay/60000)} min.`);
    this.timer = setTimeout(() => this.run(), delay);
  }

  async run() {
    if (!this.running) return;
    const slot = this._getCurrentSlot();
    if (!this._isActiveHour() || !slot) { this._schedule(null); return; }

    const timeOption = this._pickTimeOption(slot);
    const label      = TIME_LABELS[timeOption] ?? `${timeOption}s`;
    const hour       = this._nlTime().h;
    logger.info(`[Autofarm] === Ronde | ${hour}u | optie: ${label} ===`);

    const roundStart = Date.now();
    let wood = 0, stone = 0, iron = 0, farms = 0, success = false;

    try {
      const towns = await this.api.getTowns();
      for (const town of towns) {
        const r = await this._farmTown(town, timeOption);
        if (r) {
          wood  += r.wood  ?? 0;
          stone += r.stone ?? 0;
          iron  += r.iron  ?? 0;
          farms += r.farms ?? 0;
          success = true;
          await this._sleep(2000 + Math.random() * 3000);
        }
      }

      // Stats bijhouden
      this.stats.runs++;
      this.stats.totalWood  += wood;
      this.stats.totalStone += stone;
      this.stats.totalIron  += iron;
      this.stats.totalFarms += farms;
      this.stats.byTimeOption[label] = (this.stats.byTimeOption[label] ?? 0) + 1;

      // Historiek bijhouden (max 50 rondes)
      this.history.push({
        time: new Date().toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" }),
        label, wood, stone, iron, farms, success,
        duration: Math.round((Date.now() - roundStart) / 1000),
      });
      if (this.history.length > 50) this.history.shift();

      if (farms > 0) {
        logger.info(`[Autofarm] ✓ ${farms} dorpen | 🪵${wood} 🪨${stone} 🪙${iron}`);
      }

      if (this.stats.runs % this.schedule.report_every_n_runs === 0) {
        await this._sendReport();
      }

    } catch (err) {
      this.stats.failedRuns++;
      logger.error(`[Autofarm] Fout: ${err.message}`);
      await this._handleCaptcha(err.message);
    }

    this._schedule(slot);
  }

  async _farmTown(town, timeOption) {
    logger.info(`[Autofarm] Stad: ${town.name}`);
    try {
      const { ready, owned } = await this.api.getFarmOverview(town);
      if (ready.length === 0) { logger.info(`[Autofarm]   Niets klaar.`); return null; }
      await this._sleep(400 + Math.random() * 800);
      const result = await this.api.claimLoads(town, owned.map(v => v.id), timeOption);
      if (result) return { ...result, farms: ready.length };
    } catch (err) {
      logger.error(`[Autofarm]   Fout bij ${town.name}: ${err.message}`);
      throw err;
    }
    return null;
  }

  async _handleCaptcha(message) {
    if (!message?.toLowerCase().match(/captcha|robot|verificat|beveil/)) return;
    logger.error("[Autofarm] 🚨 CAPTCHA gedetecteerd!");

    const text = [
      `🚨 CAPTCHA GEDETECTEERD`,
      ``,
      `Tijdstip: ${new Date().toLocaleString("nl-BE")}`,
      `Wereld:   ${this.world.toUpperCase()}`,
      ``,
      `De bot heeft een CAPTCHA gedetecteerd en is automatisch gestopt.`,
      ``,
      `Wat te doen:`,
      `  1. Open Grepolis in je browser`,
      `  2. Los de CAPTCHA op`,
      `  3. Exporteer je cookies opnieuw via Cookie-Editor`,
      `  4. Update de GREPO_COOKIES secret op GitHub`,
      ``,
      `De bot herstart automatisch na 45 minuten.`,
    ].join("\n");

    await this.mailer.send("🚨 CAPTCHA gedetecteerd — actie vereist!", text);
    this.stop();
    setTimeout(() => { logger.info("[Autofarm] Herstart na CAPTCHA-pauze."); this.start(); }, 45 * 60 * 1000);
  }

  async _sendReport() {
    const now     = new Date();
    const elapsed = Math.round((Date.now() - this.stats.lastReport) / 60000);
    const totaal  = this.stats.totalWood + this.stats.totalStone + this.stats.totalIron;
    const uptime  = Math.round((Date.now() - this.startTime) / 60000);

    // Berekening per uur
    const perUur = elapsed > 0 ? Math.round(totaal / elapsed * 60) : 0;

    // Meest gebruikte tijdoptie
    const topOptie = Object.entries(this.stats.byTimeOption)
      .sort((a, b) => b[1] - a[1])[0];

    // Laatste 5 rondes
    const recentRondes = this.history.slice(-5).reverse().map(r =>
      `  ${r.time} | ${r.label.padEnd(6)} | 🪵${String(r.wood).padStart(4)} 🪨${String(r.stone).padStart(4)} 🪙${String(r.iron).padStart(4)} | ${r.farms} dorpen`
    ).join("\n");

    const text = [
      `📊 FARM RAPPORT — ${now.toLocaleString("nl-BE")}`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📈 SAMENVATTING (${this.stats.runs} rondes, ~${elapsed} min)`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `  🪵 Hout:    ${this.stats.totalWood.toLocaleString("nl-BE").padStart(8)}`,
      `  🪨 Steen:   ${this.stats.totalStone.toLocaleString("nl-BE").padStart(8)}`,
      `  🪙 Zilver:   ${this.stats.totalIron.toLocaleString("nl-BE").padStart(8)}`,
      `  📦 Totaal:  ${totaal.toLocaleString("nl-BE").padStart(8)}`,
      ``,
      `  ⚡ Gemiddeld per uur: ~${perUur.toLocaleString("nl-BE")} grondstoffen`,
      `  🏘️  Totaal gefarmd:   ${this.stats.totalFarms} dorpsbeurten`,
      `  ❌ Mislukte rondes:   ${this.stats.failedRuns}`,
      `  ⏱️  Bot actief:        ${uptime} minuten`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `⏰ TIJDOPTIES GEBRUIKT`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      ...Object.entries(this.stats.byTimeOption).map(([k, v]) =>
        `  ${k.padEnd(8)}: ${v}x ${topOptie[0] === k ? "← meest gebruikt" : ""}`
      ),
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🕐 LAATSTE 5 RONDES`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      recentRondes || "  Geen rondes beschikbaar.",
      ``,
      `Bot draait normaal ✅`,
    ].join("\n");

    logger.info(`[Autofarm] Rapport verstuurd.`);
    await this.mailer.send(`📊 Farm Rapport — ${totaal.toLocaleString("nl-BE")} grondstoffen`, text);

    // Reset stats voor volgende periode
    this.stats = this._emptyStats();
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = Autofarm;
