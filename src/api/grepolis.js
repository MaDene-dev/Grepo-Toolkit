const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session;
  }

  async getTowns() {
    // Probeer meerdere bekende actienamen voor het ophalen van steden
    const actions = ["getTowns", "fetchTowns", "loadTowns", "GameDataModel"];

    for (const action of actions) {
      try {
        logger.info(`[API] getTowns proberen via actie: "${action}"`);
        const data = await this.session.ajax(action, 0);
        const raw = JSON.stringify(data).substring(0, 300);
        logger.info(`[API] Response (${action}): ${raw}`);

        // Controleer of het een bruikbare response is
        if (data && data.towns) {
          const towns = Object.values(data.towns);
          logger.info(`[API] ${towns.length} steden gevonden via "${action}"`);
          return towns;
        }

        if (data && data.error) {
          logger.warn(`[API] Fout van server (${action}): ${data.error}`);
        }
      } catch (err) {
        logger.warn(`[API] "${action}" mislukt: ${err.message}`);
      }
    }

    // Als geen enkele actie werkt, probeer via de game-data URL direct
    logger.info("[API] Probeer steden ophalen via game-data URL...");
    try {
      const data = await this.session.getJson(
        `/game/${this.session.world}/index+Us+ITowns.json`
      );
      const raw = JSON.stringify(data).substring(0, 300);
      logger.info(`[API] ITowns response: ${raw}`);

      if (data && data.towns) {
        return Object.values(data.towns);
      }
      if (Array.isArray(data)) return data;
    } catch (err) {
      logger.warn(`[API] ITowns URL mislukt: ${err.message}`);
    }

    throw new Error("Kon steden niet ophalen — zie logs voor details.");
  }

  async getFarmingVillages(townId) {
    const actions = ["fetchFarmTowns", "getFarmTowns", "farmTowns"];
    for (const action of actions) {
      try {
        const data = await this.session.ajax(action, townId);
        if (data && data.farm_towns) return Object.values(data.farm_towns);
        if (data && !data.error) {
          logger.info(`[API] getFarmingVillages (${action}) response: ${JSON.stringify(data).substring(0, 200)}`);
        }
      } catch (err) {
        logger.warn(`[API] "${action}" voor town ${townId}: ${err.message}`);
      }
    }
    return [];
  }

  async farmVillage(townId, farmTownId, mode = "loot") {
    const actionMap = { loot: "farmTownLoot", demand: "farmTownDemand" };
    const action = actionMap[mode] || "farmTownLoot";
    const data = await this.session.ajax(action, townId, { farm_town_id: farmTownId });
    return data;
  }
}

module.exports = GrepolisAPI;
