const logger = require("../utils/logger");

class Autofarm {
  constructor(api, config) {
    this.api = api;
    this.config = config.autofarm;
    this.running = false;
    this.timer = null;
  }

  start() {
    if (!this.config.enabled) { logger.info("[Autofarm] Uitgeschakeld."); return; }
    logger.info("[Autofarm] Gestart — eerste ronde begint direct.");
    this.running = true;
    this.run();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  _schedule() {
    if (!this.running) return;
    const baseMs = this.config.interval_minutes * 60 * 1000;
    const jitter = this.config.randomize_interval
      ? (Math.random() * 2 - 1) * this.config.randomize_range_minutes * 60 * 1000 : 0;
    const delay = Math.max(60_000, baseMs + jitter);
    logger.info(`[Autofarm] Volgende ronde over ${Math.round(delay / 60000)} minuten.`);
    this.timer = setTimeout(() => this.run(), delay);
  }

  async run() {
    if (!this.running) return;
    logger.info("[Autofarm] === Farm-ronde gestart ===");
    try {
      const towns = await this.api.getTowns();
      for (const town of towns) {
        await this._farmTown(town);
        await this._sleep(2000 + Math.random() * 2000);
      }
    } catch (err) {
      logger.error(`[Autofarm] Fout: ${err.message}`);
    }
    logger.info("[Autofarm] === Farm-ronde afgerond ===");
    this._schedule();
  }

  async _farmTown(town) {
    logger.info(`[Autofarm] Stad: ${town.name} (id: ${town.id})`);
    try {
      const { ready, owned } = await this.api.getFarmOverview(town);

      if (ready.length === 0) {
        logger.info(`[Autofarm]   Niets klaar.`);
        return;
      }

      await this._sleep(500 + Math.random() * 1000);
      const ownedIds = owned.map(v => v.id);
      const succes = await this.api.claimLoads(town, ownedIds);

      if (succes) {
        logger.info(`[Autofarm]   ✓ Gefarmd! ${ready.length} dorpen.`);
      } else {
        logger.warn(`[Autofarm]   Claim mislukt voor ${town.name}.`);
      }
    } catch (err) {
      logger.error(`[Autofarm]   Fout bij ${town.name}: ${err.message}`);
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = Autofarm;
