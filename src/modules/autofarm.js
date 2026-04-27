const logger = require("../utils/logger");

class Autofarm {
  constructor(api, config) {
    this.api = api;
    this.config = config.autofarm;
    this.running = false;
    this.timer = null;
    this.lastFarmed = {}; // { townId: timestamp }
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
      logger.error(`[Autofarm] Fout tijdens farm-ronde: ${err.message}`);
    }

    logger.info("[Autofarm] === Farm-ronde afgerond ===");
    this._schedule();
  }

  async _farmTown(town) {
    logger.info(`[Autofarm] Stad: ${town.name} (id: ${town.id}, eiland: ${town.island_x},${town.island_y})`);

    try {
      // Stap 1: Haal farming villages op om te zien wat beschikbaar is
      const villages = await this.api.getFarmingVillages(town);

      if (!villages.length) {
        logger.info(`[Autofarm]   Geen farming villages gevonden.`);
        return;
      }

      const beschikbaar = villages.filter(v => this._isAvailable(v));
      logger.info(`[Autofarm]   ${villages.length} dorpen, ${beschikbaar.length} beschikbaar.`);

      if (beschikbaar.length === 0) {
        logger.info(`[Autofarm]   Alles in cooldown, sla over.`);
        return;
      }

      // Stap 2: Claim alle beschikbare grondstoffen in één call
      const succes = await this.api.claimLoads(town.id);
      if (succes) {
        this.lastFarmed[town.id] = Date.now();
        logger.info(`[Autofarm]   ✓ ${beschikbaar.length} dorpen gefarmd.`);
      } else {
        logger.warn(`[Autofarm]   claim_loads mislukt voor ${town.name}.`);
      }
    } catch (err) {
      logger.warn(`[Autofarm]   Fout bij ${town.name}: ${err.message}`);
    }
  }

  // Controleer of een dorp beschikbaar is (cooldown voorbij)
  _isAvailable(village) {
    if (village.looting_cooldown_end_at) {
      return Date.now() / 1000 > village.looting_cooldown_end_at;
    }
    if (village.available_at) {
      return Date.now() / 1000 > village.available_at;
    }
    // Als geen cooldown-veld: beschikbaar
    return true;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = Autofarm;
