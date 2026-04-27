const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session;
  }

  async getTowns() {
    // Grepolis vereist player_id in de payload voor town-gerelateerde calls
    const playerId = this.session.playerId;
    const toTry = [
      { action: "getTowns",            extra: { player_id: playerId } },
      { action: "fetchTowns",          extra: { player_id: playerId } },
      { action: "getTownsForPlayer",   extra: { player_id: playerId } },
      { action: "fetchTownsForPlayer", extra: { player_id: playerId } },
      { action: "getTowns",            extra: { } },
    ];

    for (const { action, extra } of toTry) {
      try {
        const data = await this.session.ajax(action, 0, extra);
        const unwrapped = data?.json ?? data;
        const raw = JSON.stringify(unwrapped).substring(0, 300);
        logger.info(`[API] ${action}: ${raw}`);

        if (unwrapped?.towns) {
          const towns = Object.values(unwrapped.towns);
          if (towns.length > 0) {
            logger.info(`[API] ${towns.length} steden gevonden via "${action}"`);
            return towns;
          }
        }
        if (unwrapped?.error) {
          logger.warn(`[API] ${action} fout: ${unwrapped.error}`);
        }
      } catch (err) {
        logger.warn(`[API] ${action} exception: ${err.message}`);
      }
    }

    // Laatste kans: probeer via player_id in de town_id positie
    try {
      const data = await this.session.ajax("getTowns", playerId);
      const unwrapped = data?.json ?? data;
      logger.info(`[API] getTowns(town_id=player_id): ${JSON.stringify(unwrapped).substring(0, 300)}`);
      if (unwrapped?.towns) return Object.values(unwrapped.towns);
    } catch (err) {
      logger.warn(`[API] Laatste poging mislukt: ${err.message}`);
    }

    throw new Error("Kon steden niet ophalen — zie logs.");
  }

  async getFarmingVillages(townId) {
    const data = await this.session.ajax("fetchFarmTowns", townId);
    const unwrapped = data?.json ?? data;
    logger.info(`[API] getFarmingVillages(${townId}): ${JSON.stringify(unwrapped).substring(0, 300)}`);

    if (unwrapped?.farm_towns) return Object.values(unwrapped.farm_towns);
    return [];
  }

  async farmVillage(townId, farmTownId, mode = "loot") {
    const action = mode === "demand" ? "farmTownDemand" : "farmTownLoot";
    const data = await this.session.ajax(action, townId, { farm_town_id: farmTownId });
    return data?.json ?? data;
  }
}

module.exports = GrepolisAPI;
