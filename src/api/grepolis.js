const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session;
  }

  // Steden zitten al in de gamepagina HTML — geen extra API-call nodig
  async getTowns() {
    const html = this.session.lastHtml;
    if (!html) throw new Error("Geen gamepagina beschikbaar in sessie.");

    // Grepolis stopt steden in ITowns.add({...}) in de HTML
    const towns = [];
    const pattern = /ITowns\.add\((\{[\s\S]*?\})\)/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      try {
        const obj = JSON.parse(match[1]);
        Object.values(obj).forEach(t => towns.push(t));
      } catch (_) {}
    }

    if (towns.length > 0) {
      logger.info(`[API] ${towns.length} steden gevonden via ITowns in HTML`);
      return towns;
    }

    // Fallback: zoek op andere patronen
    const alt = html.match(/"towns"\s*:\s*(\{[^}]{10,}\})/);
    if (alt) {
      try {
        const obj = JSON.parse(alt[1]);
        const list = Object.values(obj);
        logger.info(`[API] ${list.length} steden gevonden via "towns" patroon`);
        return list;
      } catch (_) {}
    }

    // Log stuk HTML rond "town" voor diagnose
    const idx = html.indexOf("ITowns");
    if (idx !== -1) {
      logger.info(`[API] ITowns context: ${html.substring(idx, idx + 300)}`);
    } else {
      logger.warn("[API] 'ITowns' niet gevonden in HTML");
      // Log stuk rond 'town_id' als alternatief
      const idx2 = html.indexOf("town_id");
      if (idx2 !== -1) logger.info(`[API] town_id context: ${html.substring(idx2, idx2 + 300)}`);
    }

    throw new Error("Kon steden niet vinden in gamepagina.");
  }

  async getFarmingVillages(townId) {
    const data = await this.session.ajax("fetchFarmTowns", townId);
    const unwrapped = data?.json ?? data;

    if (unwrapped?.farm_towns) return Object.values(unwrapped.farm_towns);
    if (unwrapped?.error) logger.warn(`[API] getFarmingVillages fout: ${unwrapped.error}`);

    // Log de response zodat we de structuur kunnen zien
    logger.info(`[API] getFarmingVillages response: ${JSON.stringify(data).substring(0, 300)}`);
    return [];
  }

  async farmVillage(townId, farmTownId, mode = "loot") {
    const action = mode === "demand" ? "farmTownDemand" : "farmTownLoot";
    const data = await this.session.ajax(action, townId, { farm_town_id: farmTownId });
    const unwrapped = data?.json ?? data;
    return unwrapped;
  }
}

module.exports = GrepolisAPI;
