const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session;
  }

  async getTowns() {
    if (this.session.config.account.towns?.length > 0) {
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

    // CAPTCHA check
    if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
      throw new Error("CAPTCHA gedetecteerd in response");
    }

    const now      = Math.floor(Date.now() / 1000);
    const farmList = data?.farm_town_list ?? [];
    const owned    = farmList.filter(v => v.rel === 1);
    const ready    = owned.filter(v => !v.loot || v.loot < now);

    logger.info(`[API] ${owned.length} eigen dorpen, ${ready.length} klaar`);
    return { owned, ready };
  }

  async claimLoads(town, farmTownIds, timeOption = 300) {
    const jsonPayload = JSON.stringify({
      farm_town_ids:   farmTownIds,
      time_option:     timeOption,
      claim_factor:    "normal",
      current_town_id: town.id,
      town_id:         town.id,
      nl_init:         true,
    });

    const data = await this.session.gamePost(
      "farm_town_overviews", town.id, "claim_loads", jsonPayload
    );

    // CAPTCHA check
    if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
      throw new Error("CAPTCHA gedetecteerd in response");
    }

    if (data?.success) {
      const res = data.resources ?? {};
      return { wood: res.wood ?? 0, stone: res.stone ?? 0, iron: res.iron ?? 0 };
    }

    if (data?.error) {
      logger.warn(`[API] claim_loads fout: ${data.error}`);
    }
    return null;
  }
}

module.exports = GrepolisAPI;
