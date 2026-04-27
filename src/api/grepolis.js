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
    throw new Error("Geen steden in config.json gevonden. Voeg je stad toe aan 'towns'.");
  }

  // Controleer of er grondstoffen klaar zijn om op te halen
  async checkLoadsAvailable(town) {
    const jsonPayload = JSON.stringify({
      island_x:             town.island_x,
      island_y:             town.island_y,
      booty_researched:     "",
      trade_office:         0,
      diplomacy_researched: "",
      town_id:              town.id,
      nl_init:              true,
    });

    const data = await this.session.gameGet(
      "farm_town_overviews", town.id, "get_farm_towns_for_town", jsonPayload
    );

    logger.info(`[API] Overzicht: ${JSON.stringify(data).substring(0, 400)}`);

    // Controleer via het menu of "Verzamelen" actief is
    if (data?.menu) {
      try {
        const menu = typeof data.menu === "string" ? JSON.parse(data.menu) : data.menu;
        const claimItem = menu?.fto_claim;
        if (claimItem?.className === "active") {
          logger.info(`[API] Grondstoffen beschikbaar (menu: active)`);
          return true;
        }
        logger.info(`[API] Menu status: ${JSON.stringify(claimItem)}`);
      } catch (_) {}
    }

    // Fallback: check of loads_data niet leeg is
    if (data?.loads_data && Object.keys(data.loads_data).length > 0) {
      logger.info(`[API] loads_data aanwezig: ${Object.keys(data.loads_data).join(", ")} seconden`);
      return true;
    }

    return false;
  }

  // Claim alle beschikbare grondstoffen voor een stad
  async claimLoads(townId) {
    const data = await this.session.gameGet(
      "farm_town_overviews", townId, "claim_loads"
    );
    logger.info(`[API] claim_loads response: ${JSON.stringify(data).substring(0, 400)}`);

    if (data?.error) {
      logger.warn(`[API] claim_loads fout: ${data.error}`);
      return false;
    }
    return true;
  }
}

module.exports = GrepolisAPI;
