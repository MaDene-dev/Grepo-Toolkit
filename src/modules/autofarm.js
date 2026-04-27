const logger = require("../utils/logger");

const TIME_LABELS = {
  600:   "10 min",
  2400:  "40 min",
  10800: "3u",
  28800: "8u",
  // oud formaat als fallback
  300:   "5 min",
  1200:  "20 min",
  5400:  "1u30",
  14400: "4u",
};

class Autofarm {
  constructor(api, config, mailer) {
    this.api      = api;
    this.config   = config;
    this.mailer   = mailer;
    this.schedule = config.schedule;
    this.running  = false;
    this.timer    = null;
    this.stats    = { runs: 0, totalWood: 0, totalStone: 0, totalIron: 0, lastReport: Date.now() };
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

  // Geeft huidige NL-tijd uur terug (UTC+1 winter, UTC+2 zomer)
  _nlHour() {
    const now = new Date();
    const offset = this._isDST(now) ? 2 : 1;
    return (now.getUTCHours() + offset) % 24;
  }

  _isDST(date) {
    // Zomertijd in NL: laatste zondag maart t/m laatste zondag oktober
    const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
    return date.getTimezoneOffset() < Math.max(jan, jul);
  }

  _isActiveHour() {
    const h = this._nlHour();
    const { start, end } = this.schedule.active_hours;
    return h >= start && h < end;
  }

  _getCurrentSlot() {
    const h = this._nlHour();
    return this.schedule.slots.find(s => h >= s.hour_start && h < s.hour_end) ?? null;
  }

  // Kies een time_option op basis van gewichten (weighted random)
  _pickTimeOption(slot) {
    const options = slot.options;
    const totalWeight = options.reduce((sum, o) => sum + o.weight, 0);
    let rand = Math.random() * totalWeight;
    for (const opt of options) {
      rand -= opt.weight;
      if (rand <= 0) return opt.time_option;
    }
    return options[options.length - 1].time_option;
  }

  // Interval met jitter + extra menselijke variatie
  _calcDelay(slot) {
    const baseMs = slot.interval_minutes * 60 * 1000;
    // Gaussische jitter: soms een stuk vroeger of later
    const jitterMs = (Math.random() * 2 - 1) * slot.jitter_minutes * 60 * 1000;
    // Kleine kans (10%) op een extra lange pauze — alsof je even weg bent
    const extraBreak = Math.random() < 0.10
      ? (5 + Math.random() * 10) * 60 * 1000
      : 0;
    return Math.max(60_000, baseMs + jitterMs + extraBreak);
  }

  _schedule(slot) {
    if (!this.running) return;

    if (!slot || !this._isActiveHour()) {
      const nextCheckMs = (15 + Math.random() * 10) * 60 * 1000; // 15-25 min
      logger.info(`[Autofarm] Buiten actieve uren (${this._nlHour()}u). Check over ${Math.round(nextCheckMs/60000)} min.`);
      this.timer = setTimeout(() => this.run(), nextCheckMs);
      return;
    }

    const delay = this._calcDelay(slot);
    const mins  = Math.round(delay / 60000);
    logger.info(`[Autofarm] Slot ${slot.hour_start}-${slot.hour_end}u | Volgende ronde over ${mins} min.`);
    this.timer = setTimeout(() => this.run(), delay);
  }

  async run() {
    if (!this.running) return;

    const slot = this._getCurrentSlot();

    if (!this._isActiveHour() || !slot) {
      this._schedule(null);
      return;
    }

    const timeOption = this._pickTimeOption(slot);
    const label      = TIME_LABELS[timeOption] ?? `${timeOption}s`;
    logger.info(`[Autofarm] === Ronde | ${this._nlHour()}u | optie: ${label} ===`);

    try {
      const towns = await this.api.getTowns();
      let wood = 0, stone = 0, iron = 0, farms = 0;

      for (const town of towns) {
        const r = await this._farmTown(town, timeOption);
        if (r) {
          wood  += r.wood  ?? 0;
          stone += r.stone ?? 0;
          iron  += r.iron  ?? 0;
          farms += r.farms ?? 0;
          await this._sleep(2000 + Math.random() * 3000);
        }
      }

      this.stats.runs++;
      this.stats.totalWood  += wood;
      this.stats.totalStone += stone;
      this.stats.totalIron  += iron;

      if (farms > 0) {
        logger.info(`[Autofarm] ✓ ${farms} dorpen | 🪵${wood} 🪨${stone} ⚙️${iron}`);
      }

      if (this.stats.runs % this.schedule.report_every_n_runs === 0) {
        await this._sendReport();
      }

    } catch (err) {
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
      throw err; // doorgeven voor captcha-check
    }
    return null;
  }

  async _handleCaptcha(message) {
    if (!message?.toLowerCase().match(/captcha|robot|verificat|beveil/)) return;
    logger.error("[Autofarm] 🚨 CAPTCHA gedetecteerd! Bot pauzeert 45 minuten.");
    await this.mailer.send(
      "🚨 Grepolis Bot — CAPTCHA gedetecteerd!",
      `Tijdstip: ${new Date().toLocaleString("nl-BE")}\n\nDe bot heeft een CAPTCHA gedetecteerd en is gestopt.\nLos de CAPTCHA op in je browser en de bot herstart automatisch na 45 minuten.`
    );
    this.stop();
    setTimeout(() => { logger.info("[Autofarm] Herstart na CAPTCHA-pauze."); this.start(); }, 45 * 60 * 1000);
  }

  async _sendReport() {
    const elapsed = Math.round((Date.now() - this.stats.lastReport) / 60000);
    const totaal  = this.stats.totalWood + this.stats.totalStone + this.stats.totalIron;
    const subject = `🏛️ Grepolis Bot — ${this.stats.runs} rondes voltooid`;
    const body = [
      `📅 ${new Date().toLocaleString("nl-BE")}`,
      ``,
      `Verslag van de laatste ${this.stats.runs} farm-rondes (~${elapsed} minuten):`,
      ``,
      `  🪵 Hout:   ${this.stats.totalWood.toLocaleString("nl-BE")}`,
      `  🪨 Steen:  ${this.stats.totalStone.toLocaleString("nl-BE")}`,
      `  ⚙️  IJzer:  ${this.stats.totalIron.toLocaleString("nl-BE")}`,
      `  📦 Totaal: ${totaal.toLocaleString("nl-BE")} grondstoffen`,
      ``,
      `Bot draait normaal ✅`,
    ].join("\n");

    logger.info(`[Autofarm] Rapport:\n${body}`);
    await this.mailer.send(subject, body);
    this.stats = { runs: 0, totalWood: 0, totalStone: 0, totalIron: 0, lastReport: Date.now() };
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = Autofarm;
