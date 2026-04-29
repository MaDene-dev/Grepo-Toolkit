const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session; // bewaar referentie voor session refresh
  }

  async getTowns() {
    // Probeer steden uit de HTML te halen (dynamisch)
    const html = this.session.lastHtml;
    if (html) {
      const towns = this._parseTownsFromHtml(html);
      if (towns.length > 0) {
        return towns;
      }
    }
    // Fallback: steden uit config.json
    if (this.session.config.account.towns?.length > 0) {
      return this.session.config.account.towns;
    }
    throw new Error("Geen steden gevonden. Voeg ze toe aan config.json.");
  }

  _parseTownsFromHtml(html) {
    const towns = [];
    // Grepolis stopt town-data in de HTML als JSON objecten
    const pattern = /\{"id"\s*:\s*(\d+)\s*,\s*"name"\s*:\s*"([^"]+)"[^}]*?"island_x"\s*:\s*(\d+)[^}]*?"island_y"\s*:\s*(\d+)/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const town = {
        id:       parseInt(match[1]),
        name:     match[2],
        island_x: parseInt(match[3]),
        island_y: parseInt(match[4]),
      };
      // Dedupliceer op basis van id
      if (!towns.find(t => t.id === town.id)) {
        towns.push(town);
      }
    }
    if (towns.length > 0) {
      logger.info(`[API] ${towns.length} steden gevonden in HTML: ${towns.map(t => t.name).join(", ")}`);
    }
    return towns;
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

    // Als er 0 eigen dorpen zijn maar de response ziet er geldig uit,
    // kan dit betekenen dat de sessie verlopen is zonder foutcode.
    // Controleer de sessie door te kijken of farm_town_list überhaupt aanwezig is.
    if (owned.length === 0 && !data?.farm_town_list) {
      logger.warn(`[API] Lege response voor ${town.name} — mogelijk verlopen sessie`);
      throw new Error("SESSION_EXPIRED");
    }

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
      // claimed_resources_per_resource_type = wat je NET opgehaald hebt per grondstof
      const claimed  = data.claimed_resources_per_resource_type ?? 0;
      const storage  = data.resources ?? {};
      return {
        wood:   claimed,
        stone:  claimed,
        iron:   claimed,
        storageWood:  storage.wood  ?? 0,
        storageStone: storage.stone ?? 0,
        storageIron:  storage.iron  ?? 0,
        storageMax:   data.storage  ?? 0,
      };
    }

    if (data?.error) {
      logger.warn(`[API] claim_loads fout: ${data.error}`);
    }
    return null;
  }
}

module.exports = GrepolisAPI;
