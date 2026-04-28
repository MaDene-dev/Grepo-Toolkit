const logger = require("../utils/logger");

const TIME_LABELS = {
  300: "5 min", 600: "10 min", 1200: "20 min", 2400: "40 min",
  5400: "1u30", 10800: "3u", 14400: "4u", 28800: "8u",
};

class Autofarm {
  constructor(api, config, mailer) {
    this.api       = api;
    this.config    = config;
    this.mailer    = mailer;
    this.schedule  = config.schedule;
    this.world     = config.account.world;
    this.running   = false;
    this.timer     = null;
    this.startTime = Date.now();
    this.roundNum  = 0;
    this.nextRunAt = null;
    this.stats     = this._emptyStats();
    this.history   = [];
  }

  _emptyStats() {
    return {
      runs: 0, failedRuns: 0,
      totalWood: 0, totalStone: 0, totalIron: 0,
      totalFarms: 0, byTimeOption: {}, lastReport: Date.now(),
    };
  }

  start() {
    this.running = true;
    this._logStartupSummary();
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

  _nlTimeStr() {
    const { h, m } = this._nlTime();
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  }

  _estimateRoundsLeft(slot) {
    if (!slot) return 0;
    const { totalMins } = this._nlTime();
    const endMins = slot.hour_end * 60;
    return Math.max(0, Math.floor((endMins - totalMins) / slot.interval_minutes));
  }

  _logStartupSummary() {
    const slot   = this._getCurrentSlot();
    const active = this._isActiveHour();
    logger.info(`[Autofarm] ═══════════════════════════════`);
    logger.info(`[Autofarm] Bot gestart | ${this._nlTimeStr()} | ${this.world.toUpperCase()}`);
    if (active && slot) {
      const rondesLeft = this._estimateRoundsLeft(slot);
      const opties = slot.options.map(o => `${TIME_LABELS[o.time_option]}(${o.weight}%)`).join(" / ");
      logger.info(`[Autofarm] Actief slot: ${slot.hour_start}:00–${slot.hour_end}:00 | interval: ~${slot.interval_minutes} min`);
      logger.info(`[Autofarm] Tijdopties: ${opties}`);
      logger.info(`[Autofarm] Geschat nog ~${rondesLeft} rondes in dit blok`);
    } else {
      const m = this.schedule.active_hours_morning;
      const e = this.schedule.active_hours_evening;
      logger.info(`[Autofarm] Buiten actieve uren | schema: ${m.start_h}:${String(m.start_m).padStart(2,"0")}–${m.end_h}:00 / ${e.start_h}:${String(e.start_m).padStart(2,"0")}–${e.end_h}:00`);
    }
    logger.info(`[Autofarm] Rapport na elke ${this.schedule.report_every_n_runs} rondes`);
    logger.info(`[Autofarm] ═══════════════════════════════`);
  }

  _isActiveHour() {
    const { totalMins } = this._nlTime();
    const s = this.schedule;
    if (s.active_hours_morning) {
      const { start_h, start_m, end_h, end_m } = s.active_hours_morning;
      if (totalMins >= start_h * 60 + start_m && totalMins < end_h * 60 + end_m) return true;
    }
    if (s.active_hours_evening) {
      const { start_h, start_m, end_h, end_m } = s.active_hours_evening;
      if (totalMins >= start_h * 60 + start_m && totalMins < end_h * 60 + end_m) return true;
    }
    if (s.active_hours) {
      const { h } = this._nlTime();
      return h >= s.active_hours.start && h < s.active_hours.end;
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
    if (extra > 0) logger.info(`[Autofarm] Extra pauze ingebouwd (~${Math.round(extra/60000)} min)`);
    return Math.max(60_000, base + jitter + extra);
  }

  _schedule(slot) {
    if (!this.running) return;
    if (!slot || !this._isActiveHour()) {
      const wait = (15 + Math.random() * 10) * 60 * 1000;
      this.nextRunAt = new Date(Date.now() + wait);
      logger.info(`[Autofarm] Buiten actieve uren | volgende check: ${this.nextRunAt.toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels",hour:"2-digit",minute:"2-digit",second:"2-digit"})}`);
      this.timer = setTimeout(() => this.run(), wait);
      return;
    }
    const delay = this._calcDelay(slot);
    this.nextRunAt = new Date(Date.now() + delay);
    const rondesLeft = this._estimateRoundsLeft(slot);
    logger.info(`[Autofarm] Volgende ophaling: ${this.nextRunAt.toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels",hour:"2-digit",minute:"2-digit",second:"2-digit"})} | nog ~${rondesLeft} rondes in dit blok`);
    this.timer = setTimeout(() => this.run(), delay);
  }

  async run() {
    if (!this.running) return;
    const slot = this._getCurrentSlot();
    if (!this._isActiveHour() || !slot) { this._schedule(null); return; }

    const timeOption = this._pickTimeOption(slot);
    const label      = TIME_LABELS[timeOption] ?? `${timeOption}s`;
    const roundStart = Date.now();
    this.roundNum++;
    this.stats.runs++;

    logger.info(`[Autofarm] ── Ronde #${this.roundNum} | ${this._nlTimeStr()} | optie: ${label} ──`);

    let wood = 0, stone = 0, iron = 0, farms = 0;
    let lastStorage = null;

    try {
      const towns = await this.api.getTowns();
      for (const town of towns) {
        const r = await this._farmTown(town, timeOption);
        if (r) {
          wood  += r.wood  ?? 0;
          stone += r.stone ?? 0;
          iron  += r.iron  ?? 0;
          farms += r.farms ?? 0;
          // Bewaar de meest recente opslag-info
          if (r.storageWood !== undefined) lastStorage = r;
          await this._sleep(2000 + Math.random() * 3000);
        }
      }

      this.stats.totalWood  += wood;
      this.stats.totalStone += stone;
      this.stats.totalIron  += iron;
      this.stats.totalFarms += farms;
      this.stats.byTimeOption[label] = (this.stats.byTimeOption[label] ?? 0) + 1;

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
        const storageStr = lastStorage
          ? ` | opslag: 🪵${lastStorage.storageWood} 🪨${lastStorage.storageStone} 🪙${lastStorage.storageIron}/${lastStorage.storageMax}`
          : "";
        logger.info(`[Autofarm] ✓ Ronde #${this.roundNum} | ${farms} dorpen | opgehaald: 🪵${wood} 🪨${stone} 🪙${iron}${storageStr} | ${dur}s`);
        logger.info(`[Autofarm] Cumulatief | 🪵${this.stats.totalWood} 🪨${this.stats.totalStone} 🪙${this.stats.totalIron} | ${this.stats.runs} rondes`);
      } else {
        logger.info(`[Autofarm] Ronde #${this.roundNum} | niets te halen | ${dur}s`);
      }

      if (this.stats.runs % this.schedule.report_every_n_runs === 0) {
        await this._sendReport();
      }

    } catch (err) {
      this.stats.failedRuns++;
      logger.error(`[Autofarm] Fout ronde #${this.roundNum}: ${err.message}`);
      await this._handleCaptcha(err.message);
    }

    this._schedule(slot);
  }

  async _farmTown(town, timeOption) {
    try {
      const { ready, owned } = await this.api.getFarmOverview(town);
      if (ready.length === 0) { logger.info(`[Autofarm]   ${town.name}: niets klaar`); return null; }
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
    await this.mailer.send(
      "🚨 CAPTCHA gedetecteerd — actie vereist!",
      `Tijdstip: ${new Date().toLocaleString("nl-BE")}\nWereld: ${this.world.toUpperCase()}\n\nLos de CAPTCHA op in je browser.\nDe bot herstart automatisch na 45 minuten.`
    );
    this.stop();
    setTimeout(() => { this.start(); }, 45 * 60 * 1000);
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
      return `  #${String(r.roundNum).padStart(3)} | ${r.time} | ${r.label.padEnd(6)} | opgehaald: 🪵${String(r.wood).padStart(4)} 🪨${String(r.stone).padStart(4)} 🪙${String(r.iron).padStart(4)}${opslag}`;
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
