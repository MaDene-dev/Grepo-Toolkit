const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session, config) {
    this.session    = session;
    this.config     = config || session.config || {};
    this._towns     = null;
    this._loadsData = null;
  }

  async getTowns() {
    if (this._towns?.length > 0) return this._towns;

    const cookies = await this.session.jar.getCookies(this.session.baseUrl);
    const toidCookie = cookies.find(c => c.key === "toid");
    if (!toidCookie) throw new Error("Geen toid cookie — sessie niet geldig.");
    const activeTownId = parseInt(toidCookie.value);

    const data = await this.session.gameGet(
      "farm_town_overviews", activeTownId, "index",
      JSON.stringify({ town_id: activeTownId, nl_init: true })
    );

    // Bewaar loads_data voor nauwkeurige opbrengst-schatting
    if (data?.loads_data) this._loadsData = data.loads_data;

    if (Array.isArray(data?.towns) && data.towns.length > 0) {
      this._towns = data.towns.map(t => ({
        id:                 t.id,
        name:               t.name,
        points:             t.points ?? 0,
        island_x:           t.island_x,
        island_y:           t.island_y,
        booty_researched:   t.booty_researched ?? false,
        plow_researched:    t.plow_researched ?? false,
        pottery_researched: t.pottery_researched ?? false,
        wood:               t.wood ?? 0,
        stone:              t.stone ?? 0,
        iron:               t.iron ?? 0,
        storage_volume:     t.storage_volume ?? 0,
        free_population:    t.free_population ?? 0,
        population:         t.population ?? 0,
        god:                t.god ?? "",
        farm_level:         t.farm_level ?? 0,
        storage_level:      t.storage_level ?? 0,
        thermal_level:      t.thermal_level ?? 0,
        resource_rare:      t.resource_rare ?? "",
        resource_plenty:    t.resource_plenty ?? "",
        prod_wood:          t.production?.wood ?? 0,
        prod_stone:         t.production?.stone ?? 0,
        prod_zilver:        t.production?.iron ?? t.production?.silver ?? 0,
      }));
      this._lastTownsData = this._towns; // bewaar voor voor/na vergelijking
      // Log production object eenmalig voor diagnose
      if (!this._prodLogged && this._towns.length > 0) {
        this._prodLogged = true;
        const t0raw = data.towns[0];
        if (t0raw?.production) logger.info(`[API] Productie object: ${JSON.stringify(t0raw.production)}`);
      }
      logger.info(`[API] ${this._towns.length} steden: ${this._towns.map(t => `${t.name}(${t.booty_researched ? "booty" : "basis"})`).join(", ")}`);
      return this._towns;
    }

    if (this.config.account.towns?.length > 0) {
      this._towns = this.config.account.towns;
      logger.info(`[API] ${this._towns.length} steden uit config`);
      return this._towns;
    }

    throw new Error("Geen steden gevonden.");
  }

  resetTowns() {
    this._towns     = null;
    this._loadsData = null;
  }

  async getHidesOverview() {
    const towns = await this.getTowns();
    if (!towns?.length) return {};

    const activeTown = towns[0];
    const params = new URLSearchParams({
      town_id: activeTown.id,
      action:  "hides_overview",
      h:       this.session.csrfToken,
      json:    JSON.stringify({ town_id: activeTown.id, nl_init: true }),
      _:       Date.now(),
    });
    const res = await this.session.client.get(
      `${this.session.baseUrl}/game/town_overviews?${params}`,
      { headers: { ...this.session._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } }
    );

    const html = res.data?.plain?.html ?? "";
    // Parse hide data: aangeroepen als .sendMessage('initializeResourcesCounter', resources, hides)
    function extractJSON(str, from) {
      let depth = 0, start = -1;
      for (let i = from; i < str.length; i++) {
        if (str[i] === '{') { if (start < 0) start = i; depth++; }
        else if (str[i] === '}' && --depth === 0 && start >= 0)
          return { json: str.slice(start, i + 1), end: i + 1 };
      }
      return null;
    }
    // Zoek zowel directe aanroep als sendMessage-varianten
    const fnMatch = html.match(/sendMessage\s*\(\s*['"]initializeResourcesCounter['"]\s*,/)
                 || html.match(/initializeResourcesCounter\s*\(/);
    if (!fnMatch) {
      const hasIron = html.includes('iron_stored');
      logger.warn(`[API] Geen grotten-data in response | iron_stored=${hasIron} | html-lengte=${html.length}`);
      return {};
    }
    const searchFrom = fnMatch.index + fnMatch[0].length;
    const first = extractJSON(html, searchFrom);
    const second = first ? extractJSON(html, first.end) : null;
    if (!second) {
      logger.warn("[API] Grotten: kon tweede JSON-argument niet parsen");
      return {};
    }
    try {
      const hideData = JSON.parse(second.json);
      const result = {};
      for (const [townId, d] of Object.entries(hideData)) {
        result[townId] = {
          town_id:     parseInt(townId),
          hide_stored: d.iron_stored ?? 0,
          hide_max:    d.max_storage ?? 0, // -1=onbeperkt, 0=geen grot
        };
      }
      logger.info(`[API] Grotten geladen voor ${Object.keys(result).length} steden`);
      return result;
    } catch (e) {
      logger.warn(`[API] Grotten parse fout: ${e.message}`);
      return {};
    }
  }

  async getBuildingOverview() {
    const towns = await this.getTowns();
    if (!towns?.length) return {};

    const activeTown = towns[0];
    const params = new URLSearchParams({
      town_id: activeTown.id,
      action:  "building_overview",
      h:       this.session.csrfToken,
      json:    JSON.stringify({ town_id: activeTown.id, nl_init: true }),
      _:       Date.now(),
    });
    const res = await this.session.client.get(
      `${this.session.baseUrl}/game/town_overviews?${params}`,
      { headers: { ...this.session._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } }
    );
    const html = res.data?.plain?.html ?? "";
    let buildingData = null, townData = null;
    const m1 = html.match(/var building_data = (\{[\s\S]+?\});\s*[\s\S]*?BuildingOverview/);
    if (m1) { try { buildingData = JSON.parse(m1[1]); } catch (_) {} }
    const m2 = html.match(/var town_data = (\{[\s\S]+?\});/);
    if (m2) { try { townData = JSON.parse(m2[1]); } catch (_) {} }
    if (!buildingData) { logger.warn("[API] Geen building_data in response"); return {}; }

    const BUILDINGS = ["main","hide","lumber","stoner","ironer","market","docks",
                       "barracks","wall","storage","farm","academy","temple",
                       "theater","thermal","library","lighthouse","tower","statue","oracle","trade_office"];

    // Per-stad call om bouwwachtrij te vinden
    const queues = {}; // townId → { buildingKey → queued_level }
    for (const town of towns) {
      try {
        const p2 = new URLSearchParams({
          town_id: town.id,
          action:  "building_overview",
          h:       this.session.csrfToken,
          json:    JSON.stringify({ town_id: town.id }),
          _:       Date.now(),
        });
        const r2 = await this.session.client.get(
          `${this.session.baseUrl}/game/town_overviews?${p2}`,
          { headers: { ...this.session._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } }
        );
        const h2 = r2.data?.plain?.html ?? "";

        // Debug: zoek queue-variabelen (eenmalig)
        if (!this._queueVarsLogged) {
          this._queueVarsLogged = true;
          const vars = [...h2.matchAll(/var (\w+)\s*=/g)].map(m => m[1]);
          logger.info(`[API] JS vars in per-stad HTML: ${vars.join(", ")}`);
          // Zoek expliciet naar order/queue/build gerelateerde vars
          const qvars = vars.filter(v => /order|queue|build/i.test(v));
          logger.info(`[API] Queue-gerelateerde vars: ${qvars.join(", ") || "geen"}`);
          // Log sample van de interessante vars
          for (const v of qvars.slice(0, 3)) {
            const vm = h2.match(new RegExp(`var ${v}\\s*=\\s*([\\s\\S]{0,300})`));
            if (vm) logger.info(`[API] ${v} = ${vm[1].slice(0,200)}`);
          }
        }

        queues[String(town.id)] = { html: h2 };
      } catch (e) {
        logger.warn(`[API] Queue fetch mislukt voor ${town.id}: ${e.message}`);
      }
    }
    logger.info(`[API] Queue HTML opgehaald voor ${Object.keys(queues).length} steden`);

    const result = {};
    for (const [townId, buildings] of Object.entries(buildingData)) {
      const town = towns.find(t => String(t.id) === String(townId));
      const td   = (townData ?? {})[townId] ?? {};
      const pop  = td.available_population ?? {};

      result[townId] = {
        town_id:   parseInt(townId),
        town_name: town?.name ?? townId,
        pop_max:   pop.max ?? 0,
        pop_used:  pop.blocked ?? 0,
        buildings: {},
      };

      for (const key of BUILDINGS) {
        result[townId].buildings[key] = {
          level:      buildings[key]?.level      ?? 0,
          next_level: buildings[key]?.next_level ?? buildings[key]?.level ?? 0,
        };
      }
    }

    logger.info(`[API] Gebouwen geladen voor ${Object.keys(result).length} steden`);
    return result;
  }

  // Schat opbrengst op basis van loads_data (nauwkeurig) of ruwe formule (fallback)
  estimateGain(town, readyCount, intervalKey) {
    const config  = this.config;
    const iv      = config.intervals?.[intervalKey];
    const timeOpt = town.booty_researched
      ? (iv?.time_option_booty ?? 600)
      : (iv?.time_option_base  ?? 300);

    if (this._loadsData?.[timeOpt]) {
      const resources = this._loadsData[timeOpt].resources;
      if (Array.isArray(resources) && resources.length > 0) {
        // Gemiddelde van alle resource-niveaus × aantal klare dorpen
        const avg = resources.reduce((a, b) => a + b, 0) / resources.length;
        return avg * readyCount;
      }
    }
    // Ruwe fallback
    return town.booty_researched
      ? timeOpt / 600 * 255 * readyCount
      : timeOpt / 300 * 80  * readyCount;
  }

  async getFarmOverview(town) {
    const payload = JSON.stringify({
      island_x:             town.island_x ?? 0,
      island_y:             town.island_y ?? 0,
      current_town_id:      town.id,
      booty_researched:     town.booty_researched ? "1" : "",
      diplomacy_researched: "",
      trade_office:         0,
      town_id:              town.id,
      nl_init:              false,
    });

    const data = await this.session.gameGet(
      "farm_town_overviews", town.id, "get_farm_towns_for_town", payload
    );

    if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
      throw new Error("CAPTCHA gedetecteerd");
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

    if (nextReady && ready.length === 0) {
      const minsLeft = Math.ceil((nextReady - now) / 60);
      logger.info(`[API] ${town.name}: ${owned.length} dorpen, 0 klaar (eerste klaar over ~${minsLeft} min)`);
    } else {
      logger.info(`[API] ${town.name}: ${owned.length} dorpen, ${ready.length} klaar`);
    }

    return { owned, ready, nextReady };
  }

  async claimLoads(towns, farmTownIds, intervalKey) {
    const activeTown = towns[0];
    const iv         = this.config.intervals?.[intervalKey];

    // Altijd claim_loads_multiple gebruiken (ook voor 1 stad) — zoals de UI
    if (towns.length >= 1) {
      const payload = JSON.stringify({
        towns:             towns.map(t => t.id), // eigen stad-IDs, niet farm-dorp IDs
        time_option_booty: iv?.time_option_booty ?? 600,
        time_option_base:  iv?.time_option_base  ?? 300,
        claim_factor:      "normal",
        town_d:            activeTown.id,
        nl_init:           true,
      });

      const data = await this.session.gamePost(
        "farm_town_overviews", activeTown.id, "claim_loads_multiple", payload
      );

      if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
        throw new Error("CAPTCHA gedetecteerd");
      }

      logger.info(`[API] claim_loads_multiple response keys: ${data ? Object.keys(data).join(", ") : "null"}`);

      // Response bevat bijgewerkte towns array — geen success veld
      if (data?.towns && (Array.isArray(data.towns) ? data.towns.length > 0 : Object.keys(data.towns).length > 0)) {
        const townList = Array.isArray(data.towns) ? data.towns : Object.values(data.towns);

        // Bereken totaal opgehaald per resource (verschil voor/na per stad)
        let totalWood = 0, totalStone = 0, totalIron = 0;
        let storageWood = 0, storageStone = 0, storageIron = 0, storageMax = 0;

        for (const townNa of townList) {
          // Vind de "voor" data uit de towns cache
          const tdVoor = this._lastTownsData?.find(t => t.id === townNa.id);
          if (tdVoor) {
            totalWood  += Math.max(0, (townNa.wood  ?? 0) - (tdVoor.wood  ?? 0));
            totalStone += Math.max(0, (townNa.stone ?? 0) - (tdVoor.stone ?? 0));
            totalIron  += Math.max(0, (townNa.iron  ?? 0) - (tdVoor.iron  ?? 0));
          }
          // Gebruik grootste stad voor opslag-referentie
          if ((townNa.storage_volume ?? 0) > storageMax) {
            storageMax   = townNa.storage_volume ?? 0;
            storageWood  = townNa.wood  ?? 0;
            storageStone = townNa.stone ?? 0;
            storageIron  = townNa.iron  ?? 0;
          }
        }

        // Sla bijgewerkte town data op voor voor/na vergelijking in village-agent
        this._townsNaData = townList.map(t => {
          const orig = this._lastTownsData?.find(o => o.id === t.id) ?? {};
          return {
            id: t.id, name: t.name,
            points:             t.points ?? orig.points ?? 0,
            island_x:           orig.island_x ?? t.island_x ?? 0,
            island_y:           orig.island_y ?? t.island_y ?? 0,
            booty_researched:   t.booty_researched ?? orig.booty_researched ?? false,
            plow_researched:    t.plow_researched  ?? orig.plow_researched  ?? false,
            pottery_researched: t.pottery_researched ?? orig.pottery_researched ?? false,
            wood:            t.wood ?? 0, stone: t.stone ?? 0, iron: t.iron ?? 0,
            storage_volume:  t.storage_volume ?? orig.storage_volume ?? 0,
            free_population: t.free_population ?? 0,
            population:      t.population ?? 0,
            god:             t.god ?? orig.god ?? "",
            farm_level:      t.farm_level    ?? orig.farm_level    ?? 0,
            storage_level:   t.storage_level ?? orig.storage_level ?? 0,
            thermal_level:   t.thermal_level ?? orig.thermal_level ?? 0,
            resource_rare:   t.resource_rare   ?? orig.resource_rare   ?? "",
            resource_plenty: t.resource_plenty ?? orig.resource_plenty ?? "",
            prod_wood:  t.production?.wood  ?? orig.prod_wood  ?? 0,
            prod_stone: t.production?.stone ?? orig.prod_stone ?? 0,
            prod_zilver: t.production?.iron ?? t.production?.silver ?? orig.prod_zilver ?? 0,
          };
        });

        return { wood: totalWood, stone: totalStone, iron: totalIron, storageWood, storageStone, storageIron, storageMax };
      }

      if (data?.error) logger.warn(`[API] claim_loads_multiple fout: ${JSON.stringify(data.error)}`);
      return null;
    }

    // Enkele stad: gebruik claim_loads
    const timeOption = activeTown.booty_researched
      ? (iv?.time_option_booty ?? 600)
      : (iv?.time_option_base  ?? 300);

    const payload = JSON.stringify({
      farm_town_ids:   farmTownIds,
      time_option:     timeOption,
      claim_factor:    "normal",
      current_town_id: activeTown.id,
      town_id:         activeTown.id,
      nl_init:         true,
    });

    const data = await this.session.gamePost(
      "farm_town_overviews", activeTown.id, "claim_loads", payload
    );

    if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
      throw new Error("CAPTCHA gedetecteerd");
    }

    if (data?.success) {
      const claimed = data.claimed_resources_per_resource_type ?? 0;
      const storage = data.resources ?? {};
      return {
        wood:         claimed,
        stone:        claimed,
        iron:         claimed,
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
