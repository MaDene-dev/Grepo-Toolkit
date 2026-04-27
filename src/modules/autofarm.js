const logger = require("../utils/logger");

class Autofarm {
  constructor(api, config) {
    this.api = api;
    this.config = config.autofarm;
    this.running = false;
    this.timer = null;
  }

  start() {
    if (!this.config.enabled) {
      logger.info("[Autofarm] Uitgeschakeld in config.");
      return;
    }
    logger.info("[Autofarm] Gestart — eerste ronde begint direct.");
    this.running = true;
    this.run();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    logger.info("[Autofarm] Gestopt.");
  }

  _schedule() {
    if (!this.running) return;
    const baseMs = this.config.interval_minutes * 60 * 1000;
    const jitter = this.config.randomize_interval
      ? (Math.random() * 2 - 1) * this.config.randomize_range_minutes * 60 * 1000
      : 0;
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
      // Stap 1: Controleer of er grondstoffen beschikbaar zijn
      const beschikbaar = await this.api.checkLoadsAvailable(town);

      if (!beschikbaar) {
        logger.info(`[Autofarm]   Niets te halen, alles in cooldown.`);
        return;
      }

      // Stap 2: Claim alle beschikbare grondstoffen
      logger.info(`[Autofarm]   Grondstoffen opeisen...`);
      await this._sleep(500 + Math.random() * 1000);
      const succes = await this.api.claimLoads(town.id);

      if (succes) {
        logger.info(`[Autofarm]   ✓ Grondstoffen opgehaald voor ${town.name}!`);
      } else {
        logger.warn(`[Autofarm]   Ophalen mislukt voor ${town.name}.`);
      }
    } catch (err) {
      logger.error(`[Autofarm]   Fout bij ${town.name}: ${err.message}`);
    }
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = Autofarm;
