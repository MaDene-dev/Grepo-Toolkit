const logger = require("../utils/logger");

class Autofarm {
  constructor(api, config) {
    this.api = api;
    this.config = config.autofarm;
    this.running = false;
    this.timer = null;

    // Bijhouden wanneer elk dorp voor het laast gefarmd is
    // { "townId_farmTownId": timestamp_ms }
    this.lastFarmed = {};
  }

  start() {
    if (!this.config.enabled) {
      logger.info("[Autofarm] Uitgeschakeld in config.");
      return;
    }
    logger.info("[Autofarm] Gestart.");
    this.running = true;
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    logger.info("[Autofarm] Gestopt.");
  }

  // Plant de volgende farm-ronde in
  _schedule() {
    if (!this.running) return;

    const baseMs = this.config.interval_minutes * 60 * 1000;
    const jitter = this.config.randomize_interval
      ? (Math.random() * 2 - 1) * this.config.randomize_range_minutes * 60 * 1000
      : 0;
    const delay = Math.max(60_000, baseMs + jitter); // minimaal 1 minuut

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
        await this._sleep(2000 + Math.random() * 2000); // 2-4s pauze tussen steden
      }
    } catch (err) {
      logger.error(`[Autofarm] Fout tijdens farm-ronde: ${err.message}`);
    }

    logger.info("[Autofarm] === Farm-ronde afgerond ===");
    this._schedule();
  }

  async _farmTown(town) {
    logger.info(`[Autofarm] Stad verwerken: ${town.name} (id: ${town.id})`);

    let villages;
    try {
      villages = await this.api.getFarmingVillages(town.id);
    } catch (err) {
      logger.warn(`[Autofarm]   Kon farming villages niet ophalen voor ${town.name}: ${err.message}`);
      return;
    }

    if (!villages.length) {
      logger.info(`[Autofarm]   Geen farming villages gevonden.`);
      return;
    }

    let farmed = 0;
    let skipped = 0;

    for (const village of villages) {
      const key = `${town.id}_${village.id}`;

      // Sla over als de cooldown nog niet voorbij is
      if (this._isOnCooldown(key, village)) {
        skipped++;
        continue;
      }

      try {
        const result = await this.api.farmVillage(town.id, village.id, this.config.mode);

        if (result && result.error) {
          logger.warn(`[Autofarm]   Dorp ${village.id} → fout: ${result.error}`);
        } else {
          this.lastFarmed[key] = Date.now();
          farmed++;
          logger.info(`[Autofarm]   Dorp ${village.id} gefarmd (${this.config.mode}).`);
        }
      } catch (err) {
        logger.warn(`[Autofarm]   Dorp ${village.id} mislukt: ${err.message}`);
      }

      // Kleine pauze tussen requests om detectie te vermijden
      await this._sleep(800 + Math.random() * 1200);
    }

    logger.info(`[Autofarm]   ${town.name}: ${farmed} gefarmd, ${skipped} overgeslagen.`);
  }

  // Controleer of een dorp nog in cooldown zit op basis van de server-data
  _isOnCooldown(key, village) {
    // Als de server een cooldown_end timestamp meestuurt, gebruik die
    if (village.cooldown_end) {
      const cooldownEnd = village.cooldown_end * 1000; // seconds → ms
      if (Date.now() < cooldownEnd) return true;
    }

    // Fallback: gebruik onze eigen tracking
    const last = this.lastFarmed[key];
    if (!last) return false;

    const cooldownMs = this.config.interval_minutes * 60 * 1000;
    return Date.now() - last < cooldownMs;
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = Autofarm;
