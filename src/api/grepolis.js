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

  async getRecruitOverview() {
    const towns = await this.getTowns();
    if (!towns?.length) return null;
    const activeTown = towns[0];
    const params = new URLSearchParams({
      town_id: activeTown.id,
      action:  "recruit_overview",
      h:       this.session.csrfToken,
      json:    JSON.stringify({ town_id: activeTown.id, nl_init: true }),
      _:       Date.now(),
    });
    const res = await this.session.client.get(
      `${this.session.baseUrl}/game/town_overviews?${params}`,
      { headers: { ...this.session._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } }
    );
    const data = res.data?.json?.data;
    if (!data?.towns) return null;

    // Transformeer naar town_id-gebaseerd object
    const troops = {};
    for (const t of data.towns) {
      const units = {};
      for (const u of (t.units || [])) {
        if (u.count !== undefined || u.total !== undefined) {
          units[u.id] = { count: u.count ?? 0, total: u.total ?? 0, all: u.all ?? 0 };
        }
      }
      troops[String(t.id)] = {
        name: t.name, god: t.god,
        free_population: t.free_population ?? 0,
        storage_volume:  t.storage_volume  ?? 0,
        units,
        orders: { barracks: t.orders?.barracks ?? [], docks: t.orders?.docks ?? [] },
      };
    }
    const summary = Object.values(troops).map(t =>
      `${t.name}: ${Object.values(t.units).filter(u => u.count > 0).length} soorten`
    ).join(", ");
    logger.info(`[API] Troepen: ${summary}`);
    return { troops, favor: data.favor ?? {} };
  }

  async getGodsOverview() {
    const towns = await this.getTowns();
    if (!towns?.length) return {};

    const activeTown = towns[0];
    const params = new URLSearchParams({
      town_id: activeTown.id,
      action:  "gods_overview",
      h:       this.session.csrfToken,
      json:    JSON.stringify({ town_id: activeTown.id, nl_init: true }),
      _:       Date.now(),
    });
    const res = await this.session.client.get(
      `${this.session.baseUrl}/game/town_overviews?${params}`,
      { headers: { ...this.session._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } }
    );

    const townGods = res.data?.json?.data?.town_gods ?? {};
    const result = {};
    for (const [townId, god] of Object.entries(townGods)) {
      if (god) result[townId] = god;
    }

    const found = Object.entries(result).map(([id, g]) => `${id}:${g}`).join(", ");
    logger.info(`[API] Goden: ${found || "geen"}`);
    return result;
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

    // Per-stad senate call voor bouwwachtrij (enkel niet-uitgebouwde steden)
    const devThresh = this.config?.opties?.uitgebouwd_punten ?? 20000;
    const townsToCheck = towns.filter(t => (t.points ?? 0) < devThresh);
    logger.info(`[API] Bouwwachtrij ophalen voor ${townsToCheck.length}/${towns.length} steden`);

    function extractBraced(str, from) {
      let depth = 0, start = -1;
      for (let i = from; i < str.length; i++) {
        if (str[i] === '{') { if (start < 0) start = i; depth++; }
        else if (str[i] === '}' && --depth === 0 && start >= 0)
          return { json: str.slice(start, i + 1), end: i + 1 };
      }
      return null;
    }

    function parseBuildingsIntoQueue(html, pos, target) {
      // Parseer alle aaneengesloten JSON-objecten als argumenten (voor $.extend met meerdere args)
      while (pos < html.length) {
        while (pos < html.length && /[\s,]/.test(html[pos])) pos++;
        if (html[pos] !== '{') break;
        const res = extractBraced(html, pos);
        if (!res) break;
        pos = res.end;
        try {
          const blds = JSON.parse(res.json);
          for (const [key, bld] of Object.entries(blds)) {
            target[key] = {
              current: bld.current_level ?? bld.level ?? 0,
              queued:  bld.level         ?? bld.current_level ?? 0,
            };
          }
        } catch (_) {}
      }
    }

    const queues = {}; // townId → { key → { current, queued } }
    for (const town of townsToCheck) {
      try {
        const p2 = new URLSearchParams({
          town_id: town.id,
          action:  "index",
          h:       this.session.csrfToken,
          json:    JSON.stringify({ town_id: town.id, nl_init: true }),
          _:       Date.now(),
        });
        const r2 = await this.session.client.get(
          `${this.session.baseUrl}/game/building_main?${p2}`,
          { headers: { ...this.session._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } }
        );
        const h2 = r2.data?.json?.html ?? r2.data?.plain?.html ?? "";
        queues[String(town.id)] = {};

        // Reguliere gebouwen: BuildingMain.buildings = {...}
        const bMatch = h2.match(/BuildingMain\.buildings\s*=\s*/);
        if (bMatch) {
          parseBuildingsIntoQueue(h2, bMatch.index + bMatch[0].length, queues[String(town.id)]);
        }

        // Speciale gebouwen: $.extend(BuildingMain.special_buildings_combined_group, {obj1}, {obj2})
        // Eén $.extend call met meerdere JSON-objecten als argumenten
        const extMatch2 = h2.match(/\$\.extend\s*\(\s*BuildingMain\.special_buildings_combined_group\s*,\s*/);
        if (extMatch2) {
          parseBuildingsIntoQueue(h2, extMatch2.index + extMatch2[0].length, queues[String(town.id)]);
        }

        const inQueue = Object.entries(queues[String(town.id)])
          .filter(([, q]) => q.queued > q.current)
          .map(([k, q]) => `${k}:${q.current}→${q.queued}`);
        if (inQueue.length)
          logger.info(`[API] ${town.name} wachtrij: ${inQueue.join(", ")}`);
        else if (!queues[String(town.id)] || !Object.keys(queues[String(town.id)]).length)
          logger.warn(`[API] BuildingMain.buildings niet gevonden voor ${town.name} (html-len=${h2.length})`);
      } catch (e) {
        logger.warn(`[API] Senate call mislukt voor ${town.name}: ${e.message}`);
      }
    }


    const result = {};
    for (const [townId, buildings] of Object.entries(buildingData)) {
      const town = towns.find(t => String(t.id) === String(townId));
      const td   = (townData ?? {})[townId] ?? {};
      const pop  = td.available_population ?? {};
      const qd   = queues[townId] ?? {};

      result[townId] = {
        town_id:   parseInt(townId),
        town_name: town?.name ?? townId,
        pop_max:   pop.max ?? 0,
        pop_used:  pop.blocked ?? 0,
        buildings: {},
      };

      for (const key of BUILDINGS) {
        const q = qd[key];
        result[townId].buildings[key] = {
          level:      q ? q.current : (buildings[key]?.level ?? 0),
          next_level: q ? q.queued  : (buildings[key]?.level ?? 0),
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

  // ── Trade overview ────────────────────────────────────────
  async getTradeOverview() {
    const towns = await this.getTowns();
    if (!towns?.length) return null;
    const t = towns[0];
    const params = new URLSearchParams({
      town_id: t.id, action: "trade_overview", h: this.session.csrfToken,
      json: JSON.stringify({ town_id: t.id, nl_init: true }), _: Date.now(),
    });
    const res = await this.session.client.get(
      `${this.session.baseUrl}/game/town_overviews?${params}`,
      { headers: { ...this.session._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } }
    );
    const data = res.data?.json;
    if (!data?.towns?.length) return null;
    const activeTownId = data.t_token ?? t.id;
    return {
      activeTownId,
      towns:     data.towns.map(tw => ({ ...tw, cap: tw.cap ?? 0 })),
      movements: data.movements ?? [],
    };
  }

  // ── Grondstoffen versturen tussen eigen steden ────────────
  async tradeBetweenTowns(activeTownId, fromId, toId, wood, stone, iron) {
    const params = new URLSearchParams({
      town_id: activeTownId, action: "trade_between_own_town", h: this.session.csrfToken,
    });
    // Grepolis verwacht een JSON-object in een "json" form-parameter (zoals alle andere calls)
    // Veldnamen: "from" en "to" (niet origin_town_id/target_town_id)
    const jsonPayload = JSON.stringify({
      from: fromId, to: toId,
      wood: wood || 0, stone: stone || 0, iron: iron || 0,
      town_id: activeTownId,
    });
    const body = new URLSearchParams({ json: jsonPayload });

    logger.info(`[API] Trade POST: ${activeTownId} context | ${fromId}→${toId} | 🪵${wood} 🪨${stone} 🪙${iron}`);

    const res = await this.session.client.post(
      `${this.session.baseUrl}/game/town_overviews?${params}`,
      body.toString(),
      { headers: { ...this.session._headers(), "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" } }
    );

    const data = res.data?.json;
    if (!data?.success) {
      const errMsg = data?.error ?? data?.message ?? JSON.stringify(res.data).slice(0, 200);
      logger.warn(`[API] Trade fout (${fromId}→${toId}): ${errMsg}`);
      throw new Error(errMsg ?? "Trade mislukt");
    }
    const mov = data.movements?.[0];
    return { success: true, arrival: mov?.arrival ?? null, movementId: data.new_trade_movement };
  }

  // ── Cultuur ────────────────────────────────────────────────────

  async getCultureOverview(townId) {
    const params = new URLSearchParams({
      town_id: townId,
      action:  "culture_overview",
      h:       this.session.csrfToken,
      json:    JSON.stringify({ town_id: townId, nl_init: true }),
      _:       Date.now(),
    });
    const res = await this.session.client.get(
      `${this.session.baseUrl}/game/town_overviews?${params}`,
      { headers: { ...this.session._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } }
    );
    if (this.session._isSessionExpired(res)) throw new Error("SESSION_EXPIRED");
    return res.data?.json ?? res.data;
  }

  async startCelebration(type, townId) {
    const params = new URLSearchParams({
      town_id:          townId,
      action:           "start_celebration",
      h:                this.session.csrfToken,
      celebration_type: type,
      _:                Date.now(),
    });
    const res = await this.session.client.post(
      `${this.session.baseUrl}/game/town_overviews?${params}`,
      new URLSearchParams({ json: JSON.stringify({ town_id: townId }) }).toString(),
      { headers: { ...this.session._headers(), "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } }
    );
    if (this.session._isSessionExpired(res)) throw new Error("SESSION_EXPIRED");
    return res.data?.json ?? res.data;
  }

}

module.exports = GrepolisAPI;
