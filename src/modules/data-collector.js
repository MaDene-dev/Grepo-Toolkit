/**
 * DataCollector — verantwoordelijk voor periodieke data-snapshots:
 *   - Gebouwen + bouwwachtrij
 *   - Goden
 *   - Grotten
 *   - Troepen (rekrutering)
 *
 * Wordt aangeroepen op ronde 1 of bij GAS-trigger.
 */
const logger = require("../utils/logger");

class DataCollector {
  constructor({ api, stats }) {
    this.api   = api;
    this.stats = stats;
  }

  // Vaste uren voor gebouwen-fetch (Belgische tijd)
  _shouldFetch() {
    const buildingHours = [8, 11, 14, 18, 22];
    const beTz = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
    return buildingHours.includes(beTz.getHours()) && beTz.getMinutes() < 15;
  }

  async run(roundNum, isGasTrigger) {
    const shouldCollect = roundNum === 1 && (isGasTrigger || this._shouldFetch());
    if (!shouldCollect) return;

    logger.info("[Data] Data-collectie starten...");

    // Gebouwen + bouwwachtrij
    try {
      const buildings = await this.api.getBuildingOverview();
      await this.stats.saveBuildings(buildings);
    } catch (e) {
      logger.warn(`[Data] Gebouwen: ${e.message || e}`);
    }

    // Troepen + rekrutering
    try {
      const recruit = await this.api.getRecruitOverview();
      await this.stats.saveTroops(recruit);
    } catch (e) {
      logger.warn(`[Data] Troepen: ${e.message || e}`);
    }

    // Goden (via gods_overview — geeft alle steden in één call)
    try {
      const gods = await this.api.getGodsOverview();
      await this.stats.saveGods(gods);
    } catch (e) {
      logger.warn(`[Data] Goden: ${e.message || e}`);
    }

    // Grotten
    try {
      const hides = await this.api.getHidesOverview();
      await this.stats.saveHides(hides);
    } catch (e) {
      logger.warn(`[Data] Grotten: ${e.message || e}`);
    }
  }
}

module.exports = DataCollector;
