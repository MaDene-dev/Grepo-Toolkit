const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session;
  }

  async getTowns() {
    if (this.session.config.account.towns?.length > 0) {
      logger.info(`[API] Steden uit config gebruikt`);
      return this.session.config.account.towns;
    }
    throw new Error("Geen steden in config.json gevonden.");
  }

  async getFarmOverview(town) {
    const jsonPayload = JSON.stringify({
      island_x:             town.island_x,
      island_y:             town.island_y,
      current_town_id:      town.id,
      booty_researched:     "",
      diplomacy_researched: "",
      trade_office:         0,
      town_id:              town.id,
      nl_init:              true,
    });

    const data = await this.session.gameGet(
      "farm_town_overviews", town.id, "get_farm_towns_for_town", jsonPayload
    );

    const now = Math.floor(Date.now() / 1000);
    const farmList = data?.farm_town_list ?? [];
    const owned = farmList.filter(v => v.rel === 1);
    const ready = owned.filter(v => !v.loot || v.loot < now);

    logger.info(`[API] ${owned.length} eigen dorpen, ${ready.length} klaar`);
    if (ready.length > 0) {
      logger.info(`[API] Klaar: ${ready.map(v => v.name).join(", ")}`);
    }

    return { owned, ready };
  }

  // POST met exacte payload die de browser stuurt
  async claimLoads(town, farmTownIds) {
    const jsonPayload = JSON.stringify({
      farm_town_ids:    farmTownIds,
      time_option:      300,
      claim_factor:     "normal",
      current_town_id:  town.id,
      town_id:          town.id,
      nl_init:          true,
    });

    const data = await this.session.gamePost(
      "farm_town_overviews", town.id, "claim_loads", jsonPayload
    );

    logger.info(`[API] claim_loads: ${JSON.stringify(data).substring(0, 200)}`);

    if (data?.success) {
      logger.info(`[API] ✓ ${data.success}`);
      return true;
    }
    if (data?.error) {
      logger.warn(`[API] Fout: ${data.error}`);
    }
    return false;
  }
}

module.exports = GrepolisAPI;
