const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session;
  }

  // Haalt alle steden op van de ingelogde speler
  async getTowns() {
    const data = await this.session.ajax("getTowns", 0, {
      nl_init: 1,
      device: "desktop",
    });

    if (!data || !data.towns) {
      throw new Error("Kon steden niet ophalen. Sessie verlopen?");
    }

    const towns = Object.values(data.towns);
    logger.info(`${towns.length} stad/steden gevonden.`);
    return towns;
  }

  // Haalt de farming villages op voor een specifieke stad
  async getFarmingVillages(townId) {
    const data = await this.session.ajax("fetchFarmTowns", townId);

    if (!data || !data.farm_towns) return [];

    return Object.values(data.farm_towns);
  }

  // Stuurt een farm-actie naar een boerendorp (demand of loot)
  async farmVillage(townId, farmTownId, mode = "loot") {
    const actionMap = {
      loot:   "farmTownLoot",
      demand: "farmTownDemand",
    };

    const action = actionMap[mode] || "farmTownLoot";

    const data = await this.session.ajax(action, townId, {
      farm_town_id: farmTownId,
    });

    return data;
  }
}

module.exports = GrepolisAPI;
