const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session;
  }

  // Steden ophalen uit de game HTML (zoekt naar town_id en island coords)
  async getTowns() {
    const html = this.session.lastHtml;

    // Zoek alle town-blokken in de HTML
    // Grepolis stopt town-data in de vorm: {"id":3323,"name":"...","island_x":464,"island_y":455,...}
    const towns = [];
    const pattern = /\{"id"\s*:\s*(\d+)\s*,\s*"name"\s*:\s*"([^"]+)"[^}]*"island_x"\s*:\s*(\d+)[^}]*"island_y"\s*:\s*(\d+)/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      towns.push({
        id:       parseInt(match[1]),
        name:     match[2],
        island_x: parseInt(match[3]),
        island_y: parseInt(match[4]),
      });
    }

    if (towns.length > 0) {
      logger.info(`[API] ${towns.length} steden gevonden in HTML`);
      return towns;
    }

    // Fallback: gebruik steden uit config als ze ingesteld zijn
    if (this.session.config.account.towns?.length > 0) {
      logger.info(`[API] Steden uit config gebruikt`);
      return this.session.config.account.towns;
    }

    // Log stuk HTML om te helpen debuggen
    logger.warn("[API] Geen steden gevonden in HTML, zoeken naar 'island_x'...");
    const idx = html.indexOf("island_x");
    if (idx !== -1) {
      logger.info(`[API] island_x context: ${html.substring(Math.max(0, idx-100), idx+200)}`);
    } else {
      logger.warn("[API] 'island_x' niet gevonden in HTML");
    }

    throw new Error(
      "Geen steden gevonden. Voeg ze handmatig toe aan config.json (zie README)."
    );
  }

  // Farming villages ophalen voor een stad
  // Echte endpoint: GET /game/farm_town_overviews?action=get_farm_towns_for_town
  async getFarmingVillages(town) {
    const jsonPayload = JSON.stringify({
      island_x:             town.island_x,
      island_y:             town.island_y,
      booty_researched:     "",
      trade_office:         0,
      diplomacy_researched: "",
      town_id:              town.id,
      nl_init:              true,
    });

    const data = await this.session.gameGet("farm_town_overviews", town.id, "get_farm_towns_for_town", jsonPayload);

    if (data?.farm_towns) {
      return Object.values(data.farm_towns);
    }
    if (data?.error) {
      logger.warn(`[API] getFarmingVillages fout: ${data.error}`);
    }
    logger.info(`[API] getFarmingVillages response: ${JSON.stringify(data).substring(0, 300)}`);
    return [];
  }

  // Alle beschikbare grondstoffen opeisen voor een stad
  // Echte endpoint: GET /game/farm_town_overviews?action=claim_loads
  async claimLoads(townId) {
    const data = await this.session.gameGet("farm_town_overviews", townId, "claim_loads");
    const result = data?.json ?? data;
    if (result?.error) {
      logger.warn(`[API] claimLoads fout: ${result.error}`);
      return false;
    }
    return true;
  }
}

module.exports = GrepolisAPI;
