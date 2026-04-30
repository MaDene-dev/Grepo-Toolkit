const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session;
  }

  async getTowns() {
    // Stap 1: Haal town IDs op via toid cookie + game session
    const towns = await this._getTownsFromSession();
    if (towns.length > 0) return towns;

    // Stap 2: Fallback naar config/secret
    if (this.session.config.account.towns?.length > 0) {
      logger.info(`[API] ${this.session.config.account.towns.length} steden uit config`);
      return this.session.config.account.towns;
    }

    throw new Error("Geen steden gevonden. Voeg towns toe aan het GREPO_ACCOUNT secret.");
  }

  async _getTownsFromSession() {
    try {
      // Haal actief town ID op uit toid cookie
      const cookies = await this.session.jar.getCookies(this.session.baseUrl);
      const toidCookie = cookies.find(c => c.key === "toid");
      if (!toidCookie) return [];

      const activeTownId = parseInt(toidCookie.value);
      logger.info(`[API] Actief town ID via cookie: ${activeTownId}`);

      // Probe call: farm_town_overviews met nl_init=true geeft extra game data terug
      // Coördinaten 0,0 — Grepolis gebruikt enkel town_id voor server-side lookup
      const payload = JSON.stringify({
        island_x: 0, island_y: 0,
        current_town_id: activeTownId,
        booty_researched: "", diplomacy_researched: "",
        trade_office: 0, town_id: activeTownId, nl_init: true,
      });

      const data = await this.session.gameGet(
        "farm_town_overviews", activeTownId,
        "get_farm_towns_for_town", payload
      );

      // nl_init response bevat player_towns met alle steden
      if (data?.player_towns) {
        const list = Array.isArray(data.player_towns)
          ? data.player_towns
          : Object.values(data.player_towns);
        if (list.length > 0) {
          const towns = list.map(t => ({
            id: t.id, name: t.name,
            island_x: t.island_x ?? t.x ?? 0,
            island_y: t.island_y ?? t.y ?? 0,
          }));
          logger.info(`[API] ${towns.length} steden gevonden: ${towns.map(t => t.name).join(", ")}`);
          return towns;
        }
      }

      // Log wat de nl_init response bevat voor diagnose
      const keys = data ? Object.keys(data).join(", ") : "leeg";
      logger.info(`[API] nl_init response keys: ${keys}`);

      // Als nl_init geen towns geeft, gebruik toch het actieve town met 0,0 coords
      // farm_town_overviews werkt op basis van town_id, island coords zijn optioneel
      if (data?.farm_town_list !== undefined) {
        logger.info(`[API] Werkt zonder island coords — gebruik town ${activeTownId}`);
        return [{ id: activeTownId, name: `Stad ${activeTownId}`, island_x: 0, island_y: 0 }];
      }

    } catch (err) {
      logger.warn(`[API] Session towns fout: ${err.message}`);
    }
    return [];
  }

  async getFarmOverview(town) {
    const payload = JSON.stringify({
      island_x:             town.island_x ?? 0,
      island_y:             town.island_y ?? 0,
      current_town_id:      town.id,
      booty_researched:     "",
      diplomacy_researched: "",
      trade_office:         0,
      town_id:              town.id,
      nl_init:              false,
    });

    const data = await this.session.gameGet(
      "farm_town_overviews", town.id, "get_farm_towns_for_town", payload
    );

    if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
      throw new Error("CAPTCHA gedetecteerd in response");
    }

    const now      = Math.floor(Date.now() / 1000);
    const farmList = data?.farm_town_list ?? [];
    const owned    = farmList.filter(v => v.rel === 1);
    const ready    = owned.filter(v => !v.loot || v.loot < now);

    if (owned.length === 0 && !data?.farm_town_list) {
      logger.warn(`[API] Lege response voor ${town.name} — mogelijk verlopen sessie`);
      throw new Error("SESSION_EXPIRED");
    }

    const cooldowns = owned.filter(v => v.loot && v.loot > now).map(v => v.loot);
    const nextReady = cooldowns.length > 0 ? Math.min(...cooldowns) : null;

    if (nextReady) {
      const minsLeft = Math.ceil((nextReady - now) / 60);
      logger.info(`[API] ${owned.length} eigen dorpen, ${ready.length} klaar${ready.length === 0 ? ` (eerste klaar over ~${minsLeft} min)` : ""}`);
    } else {
      logger.info(`[API] ${owned.length} eigen dorpen, ${ready.length} klaar`);
    }

    return { owned, ready, nextReady };
  }

  async claimLoads(town, farmTownIds, timeOption = 300) {
    const payload = JSON.stringify({
      farm_town_ids:   farmTownIds,
      time_option:     timeOption,
      claim_factor:    "normal",
      current_town_id: town.id,
      town_id:         town.id,
      nl_init:         true,
    });

    const data = await this.session.gamePost(
      "farm_town_overviews", town.id, "claim_loads", payload
    );

    if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
      throw new Error("CAPTCHA gedetecteerd in response");
    }

    if (data?.success) {
      const claimed = data.claimed_resources_per_resource_type ?? 0;
      const storage = data.resources ?? {};
      return {
        wood:  claimed, stone: claimed, iron: claimed,
        storageWood:  storage.wood  ?? 0,
        storageStone: storage.stone ?? 0,
        storageIron:  storage.iron  ?? 0,
        storageMax:   data.storage  ?? 0,
      };
    }

    if (data?.error) logger.warn(`[API] claim_loads fout: ${data.error}`);
    return null;
  }
}

module.exports = GrepolisAPI;
