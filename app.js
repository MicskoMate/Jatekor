/* app.js — Játékóra (Supabase backend: rooms, room_state, players, player_state, color_slots)
   RPC-k: create_room, get_room_public, join_room, pass_to_color, start_combat, end_combat, dm_new_phase, dm_set_color_slot

   URL:
     Player: ?room=ABC123
     DM:     ?room=ABC123&dm=TOKEN

   Követelmény:
     index.html betölti:
       <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
       <script src="./app.js"></script>
*/

(() => {
  "use strict";

  // ========= CONFIG =========
  const SUPABASE_URL = window.__SUPABASE_URL__ || "https://hjagqceimgujknfuyjwd.supabase.co";
  const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__ || "sb_publishable_NmqMqN6jb33gDn1qnyGU8w_45kWKwa-";

  const url = new URL(window.location.href);
  const ROOM_CODE = (url.searchParams.get("room") || "").trim();
  const DM_TOKEN = (url.searchParams.get("dm") || "").trim();
  const IS_DM = !!DM_TOKEN;

  // ========= BASIC GUARDS =========
  if (!window.supabase) {
    fatal("Hiányzik a supabase-js script az index.html-ből.");
    return;
  }
  if (SUPABASE_URL.includes("PASTE_") || SUPABASE_ANON_KEY.includes("PASTE_")) {
    fatal("Add meg az SUPABASE_URL és SUPABASE_ANON_KEY értékeket az app.js-ben.");
    return;
  }

  const { createClient } = window.supabase;
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  // ========= STATE =========
  let session = null;
  let userId = null;

  let roomId = null;
  let roomCode = ROOM_CODE; // normalized by RPC anyway

  let colorSlots = []; // [{room_id,color,idx,locked,join_code_hash}]
  let players = [];    // [{id,room_id,user_id,color,created_at}]
  let roomState = null; // row from room_state
  let playerStates = []; // [{room_id,player_id,phase,base_seconds,spent_seconds}]
  let DM_INPUT_ACTIVE = false;
  let myPlayer = null; // player row
  // DM egyéni idők (szín -> másodperc vagy null)
  const dmOverrideDraft = {};
  const dmNameDraft = {}; // { color: "név" }



  let chPlayers = null;
  let chRoomState = null;
  let chPlayerState = null;
  let chColorSlots = null;

  // ========= DOM HOOKS (ids from your index.html if present) =========
  const el = {
    roomLabel: document.getElementById("roomLabel"),
    btnCreateRoom: document.getElementById("btnCreateRoom"),
    btnCopyPlayer: document.getElementById("btnCopyPlayer"),
    btnCopyDM: document.getElementById("btnCopyDM"),
    joinCard: document.getElementById("joinCard"),
    roomCodeInput: document.getElementById("roomCodeInput"),
    btnJoin: document.getElementById("btnJoin")
  };

  // We'll create missing UI containers if not present
  const ui = {
    root: document.body,
    mainWrap: document.querySelector("main.wrap") || document.body
  };

  // dynamic sections
  let gridWrap, dmWrap, overlay;

  // ========= HELPERS =========
  function nowMs() { return Date.now(); }
  function parseISO(s) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  function pad2(n) { n = Math.max(0, Math.floor(n)); return (n < 10 ? "0" : "") + n; }
  function formatMMSS(totalSeconds) {
    totalSeconds = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${pad2(m)}:${pad2(s)}`;
  }
  function parseMMSS(input) {
    const t = String(input || "").trim();
    if (!t) return null;
    const parts = t.split(":").map(x => x.trim());
    if (parts.length === 1) {
      const s = Number(parts[0]);
      return Number.isFinite(s) && s >= 0 ? Math.floor(s) : null;
    }
    if (parts.length === 2) {
      const m = Number(parts[0]);
      const s = Number(parts[1]);
      if (![m, s].every(Number.isFinite) || m < 0 || s < 0 || s >= 60) return null;
      return Math.floor(m * 60 + s);
    }
    if (parts.length === 3) {
      const h = Number(parts[0]);
      const m = Number(parts[1]);
      const s = Number(parts[2]);
      if (![h, m, s].every(Number.isFinite) || h < 0 || m < 0 || s < 0 || m >= 60 || s >= 60) return null;
      return Math.floor(h * 3600 + m * 60 + s);
    }
    return null;
  }

  function fatal(msg) {
    document.body.innerHTML = "";
    const d = document.createElement("div");
    d.style.maxWidth = "900px";
    d.style.margin = "40px auto";
    d.style.padding = "16px";
    d.style.border = "1px solid #d33";
    d.style.borderRadius = "12px";
    d.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial";
    d.style.whiteSpace = "pre-wrap";
    d.textContent = msg;
    document.body.appendChild(d);
  }

  function showRoomLabel(text) {
    if (el.roomLabel) el.roomLabel.textContent = text;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  function getPlayerState(playerId) {
    return playerStates.find(ps => ps.player_id === playerId) || null;
  }

  function isTimerRunning() {
    return !!(roomState && roomState.active_player_id && roomState.active_started_at && !roomState.combat_active);
  }

  function computeSpent(playerId) {
    const ps = getPlayerState(playerId);
    const baseSpent = ps ? (ps.spent_seconds || 0) : 0;
    if (!roomState) return baseSpent;
    if (roomState.combat_active) return baseSpent;
    if (!roomState.active_player_id || !roomState.active_started_at) return baseSpent;
    if (roomState.active_player_id !== playerId) return baseSpent;

    const started = parseISO(roomState.active_started_at);
    if (!started) return baseSpent;
    const delta = Math.max(0, Math.floor((nowMs() - started) / 1000));
    return baseSpent + delta;
  }

  function computeRemaining(playerId) {
    const ps = getPlayerState(playerId);
    const base = ps ? (ps.base_seconds || 0) : 0;
    const spent = computeSpent(playerId);
    return Math.max(0, base - spent);
  }

  function combatRemaining() {
    if (!roomState || !roomState.combat_active || !roomState.combat_started_at) return null;
    const started = parseISO(roomState.combat_started_at);
    if (!started) return null;
    const elapsed = Math.max(0, Math.floor((nowMs() - started) / 1000));
    return Math.max(0, 60 - elapsed);
  }

  function canPassToAny() {
    if (!myPlayer || !roomState) return false;
    if (roomState.combat_active) return false;
    // No timer running -> only can start own (enforced server-side too)
    if (!roomState.active_player_id || !roomState.active_started_at) return true; // but only own target; UI will restrict
    // Timer running -> only active can pass
    return roomState.active_player_id === myPlayer.id;
  }

  function canClickColor(targetColor) {
  if (!myPlayer || !roomState) return false;
  if (roomState.combat_active) return false;

  // ha nincs futó timer: csak a sajátodat indíthatod
  if (!roomState.active_player_id || !roomState.active_started_at) {
    return targetColor === myPlayer.color;
  }

  // ha fut: csak az aktív adhatja át, de saját magának ne
  if (roomState.active_player_id !== myPlayer.id) return false;
  return targetColor !== myPlayer.color;
  }

  function canStartCombat() {
    if (!myPlayer || !roomState) return false;
    if (roomState.combat_active) return false;
    return !!(roomState.active_player_id === myPlayer.id && roomState.active_started_at);
  }

  function canEndCombat() {
    if (!myPlayer || !roomState) return false;
    if (!roomState.combat_active) return false;
    // backend: only initiator
    return roomState.combat_initiator_player_id === myPlayer.id;
  }

  // ========= UI BUILD =========
  function ensureUI() {
    // Containers
    if (!gridWrap) {
      gridWrap = document.createElement("section");
      gridWrap.className = "card";
      gridWrap.style.marginTop = "12px";
      gridWrap.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div>
            <div style="font-weight:800;">Játékosok</div>
            <div id="subline" style="opacity:.7;font-size:12px;">&nbsp;</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button id="btnCombat" class="btn">HARC</button>
          </div>
        </div>
        <div id="grid" style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;"></div>
      `;
      ui.mainWrap.appendChild(gridWrap);
    }

        // DM panel: ha van a HTML-ben (#dmCard), azt használjuk
    if (!dmWrap) {
      const existingDm = document.getElementById("dmCard");
      if (existingDm) {
        dmWrap = existingDm;
      } else {
        // fallback (ha valaki olyan HTML-lel futtatja, amiben nincs dmCard)
        dmWrap = document.createElement("section");
        dmWrap.className = "card";
        dmWrap.style.marginTop = "12px";
        dmWrap.style.display = "none";
        dmWrap.innerHTML = `
          <div style="font-weight:800;">DM</div>
          <div style="opacity:.7;font-size:12px;margin-bottom:10px;">Új fázis / idők beállítása + színek előzetes zárolása</div>

          <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;">
            <input id="dmDefault" placeholder="Alapidő (mm:ss) pl. 02:00" />
            <button id="dmApply" class="btn primary">ÚJ FÁZIS / RESET</button>
          </div>

          <div id="dmOverrides" style="margin-top:10px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;"></div>

          <div style="margin-top:12px;border-top:1px solid rgba(0,0,0,0.08);padding-top:12px;">
            <div style="font-weight:800;margin-bottom:6px;">Színek (előzetes kiosztás / zárolás)</div>
            <div id="dmSlots" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;"></div>
          </div>
          <div id="dmMsg" class="msg"></div>
        `;
        ui.mainWrap.appendChild(dmWrap);
      }
    }


    if (!overlay) {
      overlay = document.createElement("div");
      overlay.style.position = "fixed";
      overlay.style.left = "0";
      overlay.style.top = "0";
      overlay.style.right = "0";
      overlay.style.zIndex = "9999";
      overlay.style.display = "none";
      overlay.style.background = "rgba(0,0,0,0.85)";
      overlay.style.color = "white";
      overlay.style.borderBottom = "1px solid rgba(255,255,255,0.15)";
      overlay.style.backdropFilter = "blur(2px)";
      overlay.style.padding = "14px 16px";
      overlay.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div>
            <div id="ovTitle" style="font-weight:900;">HARC</div>
            <div id="ovTimer" style="font-weight:900;font-size:28px;">01:00</div>
          </div>
          <button id="ovEnd" class="btn" style="background:transparent;color:white;border:1px solid rgba(255,255,255,0.35);">VÉGE</button>
        </div>
      `;
      document.body.appendChild(overlay);
    }

    // Wire buttons
    const btnCombat = gridWrap.querySelector("#btnCombat");
    const grid = gridWrap.querySelector("#grid");

    btnCombat.onclick = async () => {
      try {
        if (!canStartCombat()) return;
        const target = await pickCombatTargetColor();
        if (!target) return;
        await sb.rpc("start_combat", { p_code: roomCode, p_target_color: target });
      } catch (e) {
        alertError(e);
      }
    };

    const ovEnd = overlay.querySelector("#ovEnd");
    ovEnd.onclick = async () => {
      try {
        if (!canEndCombat()) return;
        await sb.rpc("end_combat", { p_code: roomCode });
      } catch (e) {
        alertError(e);
      }
    };

        // DM panel
    if (IS_DM && dmWrap) {
      // ha index.html-ben dmCard van, ott hidden class van használva
      dmWrap.classList.remove("hidden");
      dmWrap.style.display = ""; // fallback kompatibilitás

      const dmDefault =
        dmWrap.querySelector("#defaultTimeInput") ||
        dmWrap.querySelector("#dmDefault");

      const dmApply =
        dmWrap.querySelector("#btnNewPhase") ||
        dmWrap.querySelector("#dmApply");

      const dmMsg =
        dmWrap.querySelector("#dmMsg") ||
        dmWrap.querySelector("#dmMsg");

      if (dmApply) {
        dmApply.onclick = async () => {
          try {
            const def = parseMMSS(dmDefault?.value);
            if (def == null) throw new Error("Érvénytelen alapidő. Formátum: mm:ss (pl. 02:00).");

            // overrides összegyűjtése (index.html: #overrideGrid, fallback: #dmOverrides)
            const overrides = {};
            const ovWrap =
              dmWrap.querySelector("#overrideGrid") ||
              dmWrap.querySelector("#dmOverrides");

            for (const [color, sec] of Object.entries(dmOverrideDraft)) {
              overrides[color] = String(sec);
            }


            if (ovWrap) {
              for (const card of ovWrap.querySelectorAll("[data-color]")) {
                const color = card.getAttribute("data-color");
                const inp = card.querySelector("input");
                const sec = parseMMSS(inp?.value);
                if (sec != null) overrides[color] = String(sec);
              }
            }

            const { error } = await sb.rpc("dm_new_phase", {
              p_code: roomCode,
              p_dm_token: DM_TOKEN,
              p_default_seconds: def,
              p_overrides: overrides
            });
            if (error) throw error;

            if (dmMsg) dmMsg.textContent = "Új fázis elindítva.";
            dmDefault?.blur();
          } catch (e) {
            alertError(e);
          }
        };
      }
    }




    // Create/Join buttons from your header
    if (el.btnCreateRoom) {
      el.btnCreateRoom.onclick = async () => {
        try {
          await ensureSession();
          const { data, error } = await sb.rpc("create_room", {});
          if (error) throw error;
          const code = data?.[0]?.code;
          const tok = data?.[0]?.dm_token;
          if (!code || !tok) throw new Error("create_room nem adott vissza code/token értékeket.");

          const base = window.location.origin + window.location.pathname;
          const playerLink = `${base}?room=${encodeURIComponent(code)}`;
          const dmLink = `${base}?room=${encodeURIComponent(code)}&dm=${encodeURIComponent(tok)}`;

          showRoomLabel(`Szoba: ${code} • (új szoba létrehozva)`);

          if (el.btnCopyPlayer) el.btnCopyPlayer.classList.remove("hidden");
          if (el.btnCopyDM) el.btnCopyDM.classList.remove("hidden");

          if (el.btnCopyPlayer) el.btnCopyPlayer.onclick = () => copyToClipboard(playerLink);
          if (el.btnCopyDM) el.btnCopyDM.onclick = () => copyToClipboard(dmLink);

          // Navigate to DM link automatically
          window.location.href = dmLink;
        } catch (e) {
          alertError(e);
        }
      };
    }

    if (el.btnJoin) {
      el.btnJoin.onclick = async () => {
        try {
          const code = (el.roomCodeInput?.value || "").trim();
          if (!code) throw new Error("Adj meg szoba kódot.");
          const base = window.location.origin + window.location.pathname;
          window.location.href = `${base}?room=${encodeURIComponent(code)}`;
        } catch (e) {
          alertError(e);
        }
      };
    }
  }

  function alertError(e) {
    console.error(e);
    const msg = (e && e.message) ? e.message : String(e);
    alert(msg);
  }

  async function pickCombatTargetColor() {
    // list current taken colors (players)
    const my = myPlayer;
    if (!my) return null;

    const candidates = players
      .filter(p => p.id !== my.id)
      .map(p => p.color);

    if (!candidates.length) {
      alert("Nincs másik játékos a szobában.");
      return null;
    }

    const text = "Válassz célpontot (írd be a sorszámot):\n" +
      candidates.map((c, i) => `${i + 1}. ${c}`).join("\n");

    const ans = prompt(text, "1");
    if (ans == null) return null;
    const idx = Number(ans.trim());
    if (!Number.isFinite(idx) || idx < 1 || idx > candidates.length) return null;
    return candidates[idx - 1];
  }

  // ========= DATA LOAD =========
  async function ensureSession() {
    const { data: s1, error: e1 } = await sb.auth.getSession();
    if (e1) throw e1;
    if (s1.session) session = s1.session;
    else {
      const { data: s2, error: e2 } = await sb.auth.signInAnonymously();
      if (e2) throw e2;
      session = s2.session;
    }
    userId = session.user.id;
  }

  async function resolveRoom(code) {
    const { data, error } = await sb.rpc("get_room_public", { p_code: code });
    if (error) throw error;
    if (!data || !data.length) throw new Error("Szoba nem található.");
    roomId = data[0].room_id;
    roomCode = data[0].code;
  }

  async function joinRoomAuto() {
    const { data, error } = await sb.rpc("join_room", {
      p_code: roomCode,
      p_color: null,
      p_join_code: null
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row) throw new Error("join_room nem adott vissza player adatot.");
    // row: {player_id, color, room_id}
    // myPlayer will be loaded by selecting players
  }

  async function loadAll() {
    // color_slots
    {
      const { data, error } = await sb
        .from("color_slots")
        .select("*")
        .eq("room_id", roomId)
        .order("idx", { ascending: true });
      if (error) throw error;
      colorSlots = data || [];
    }
    // players
    {
      const { data, error } = await sb
        .from("players")
        .select("*")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      players = data || [];
      myPlayer = players.find(p => p.user_id === userId) || null;
    }
    // room_state
    {
      const { data, error } = await sb
        .from("room_state")
        .select("*")
        .eq("room_id", roomId)
        .single();
      if (error) throw error;
      roomState = data;
    }
    // player_state
    {
      const { data, error } = await sb
        .from("player_state")
        .select("*")
        .eq("room_id", roomId);
      if (error) throw error;
      playerStates = data || [];
    }
  }

  // ========= REALTIME =========
  function subscribeRealtime() {
    // cleanup
    if (chPlayers) sb.removeChannel(chPlayers);
    if (chRoomState) sb.removeChannel(chRoomState);
    if (chPlayerState) sb.removeChannel(chPlayerState);
    if (chColorSlots) sb.removeChannel(chColorSlots);

    chPlayers = sb.channel(`players:${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` }, async () => {
        await reloadPlayers();
        render();
      })
      .subscribe();

    chRoomState = sb.channel(`room_state:${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "room_state", filter: `room_id=eq.${roomId}` }, async (payload) => {
        if (payload.new) roomState = payload.new;
        render();
      })
      .subscribe();

    chPlayerState = sb.channel(`player_state:${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "player_state", filter: `room_id=eq.${roomId}` }, async () => {
        await reloadPlayerState();
        render();
      })
      .subscribe();

    chColorSlots = sb.channel(`color_slots:${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "color_slots", filter: `room_id=eq.${roomId}` }, async () => {
        await reloadColorSlots();
        render();
      })
      .subscribe();
  }

  async function reloadPlayers() {
    const { data, error } = await sb
      .from("players")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    players = data || [];
    myPlayer = players.find(p => p.user_id === userId) || null;
  }

  async function reloadPlayerState() {
    const { data, error } = await sb
      .from("player_state")
      .select("*")
      .eq("room_id", roomId);
    if (error) throw error;
    playerStates = data || [];
  }

  async function reloadColorSlots() {
    const { data, error } = await sb
      .from("color_slots")
      .select("*")
      .eq("room_id", roomId)
      .order("idx", { ascending: true });
    if (error) throw error;
    colorSlots = data || [];
  }

  // ========= RENDER =========
  function render() {
    // DM input fókusz-védelem (különben a tick újraépíti a DOM-ot és „kidob”)
    const ae = document.activeElement;
    const dmEditing =
      IS_DM &&
      ae &&
      dmWrap &&
      dmWrap.contains(ae) &&
      ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName);

    if (dmEditing || DM_INPUT_ACTIVE) return;

    ensureUI();

    // Header label
    showRoomLabel(roomCode ? `Szoba: ${roomCode}${IS_DM ? " • DM" : ""}` : "Szoba: -");

    // joinCard visibility
    if (el.joinCard) {
      // if no ?room param -> show join; else hide
      el.joinCard.classList.toggle("hidden", !!ROOM_CODE);
    }
    // ====== KEZDŐKÉPERNYŐ LOGIKA ======
    const hasRoom = !!(roomCode || ROOM_CODE);

    // Create room: csak akkor látszódjon, ha NINCS szoba kiválasztva
    if (el.btnCreateRoom) {
      el.btnCreateRoom.classList.toggle("hidden", hasRoom);
    }

    // Játékosok + HARC panel: csak akkor látszódjon, ha VAN szoba kiválasztva
    if (typeof gridWrap !== "undefined" && gridWrap) {
      gridWrap.classList.toggle("hidden", !hasRoom);
    }

    // Subline
    const subline = gridWrap.querySelector("#subline");
    if (subline) {
      const pCount = players.length;
      const phase = roomState?.phase ?? "-";
      const active = roomState?.combat_active ? "HARC" :
        (roomState?.active_player_id && roomState?.active_started_at ? "FUT" : "ÁLL");
      subline.textContent = `Játékosok: ${pCount} • Fázis: ${phase} • Állapot: ${active}`;
    }

    // Combat overlay
    const ovTitle = overlay.querySelector("#ovTitle");
    const ovTimer = overlay.querySelector("#ovTimer");
    const ovEnd = overlay.querySelector("#ovEnd");

    if (roomState?.combat_active) {
      overlay.style.display = "block";
      const init = players.find(p => p.id === roomState.combat_initiator_player_id);
      const targ = players.find(p => p.id === roomState.combat_target_player_id);
      const labelOf = (c) => {
        const s = colorSlots.find(x => x.color === c);
        return (s?.display_name && s.display_name.trim()) ? s.display_name : c;
      };
      ovTitle.textContent = `HARC: ${init ? labelOf(init.color) : "?"} ↔ ${targ ? labelOf(targ.color) : "?"}`;
      ovTimer.textContent = formatMMSS(combatRemaining() ?? 60);
      ovEnd.disabled = !canEndCombat();
      ovEnd.style.opacity = ovEnd.disabled ? "0.5" : "1";
    } else {
      overlay.style.display = "none";
    }

    // Buttons
    const btnCombat = gridWrap.querySelector("#btnCombat");
    btnCombat.disabled = !canStartCombat();
    btnCombat.style.opacity = btnCombat.disabled ? "0.5" : "1";

    // Grid
    const grid = gridWrap.querySelector("#grid");
    grid.innerHTML = "";

    // Render 4–10 colors (always show all slots)
    const shownSlots = colorSlots.slice(0, 10);

    for (const cs of shownSlots) {
      const takenBy = players.find(p => p.color === cs.color) || null;
      const isMine = takenBy && myPlayer && takenBy.id === myPlayer.id;

      const card = document.createElement("button");
      card.type = "button";
      card.style.border = "1px solid rgba(0,0,0,0.12)";
      card.style.borderRadius = "14px";
      card.style.padding = "12px";
      card.style.textAlign = "left";
      card.style.cursor = "pointer";
      card.style.background = "white";
      card.style.display = "grid";
      card.style.gap = "8px";
      card.style.position = "relative";
      card.style.userSelect = "none";

      const bar = document.createElement("div");
      bar.style.height = "10px";
      bar.style.borderRadius = "999px";
      bar.style.background = cs.color; // color is "red/blue/..." in your SQL; still works for CSS background
      card.appendChild(bar);

      const top = document.createElement("div");
      top.style.display = "flex";
      top.style.alignItems = "baseline";
      top.style.justifyContent = "space-between";
      top.style.gap = "10px";
      card.appendChild(top);

      const name = document.createElement("div");
      name.style.fontWeight = "900";
      name.textContent = (cs.display_name && cs.display_name.trim()) ? cs.display_name : cs.color;
      top.appendChild(name);

      const badge = document.createElement("div");
      badge.style.fontSize = "12px";
      badge.style.opacity = "0.75";
      if (!takenBy) badge.textContent = cs.locked ? "ZÁROLT" : "SZABAD";
      else badge.textContent = isMine ? "TE" : "FOGLALT";
      top.appendChild(badge);

      const time = document.createElement("div");
      time.style.fontSize = "34px";
      time.style.fontWeight = "900";
      if (takenBy) time.textContent = formatMMSS(computeRemaining(takenBy.id));
      else time.textContent = "--:--";
      card.appendChild(time);

      const isActive = roomState && !roomState.combat_active &&
        roomState.active_player_id && roomState.active_player_id === takenBy?.id &&
        roomState.active_started_at;

      if (isActive) {
        const dot = document.createElement("div");
        dot.style.position = "absolute";
        dot.style.right = "12px";
        dot.style.top = "12px";
        dot.style.width = "12px";
        dot.style.height = "12px";
        dot.style.borderRadius = "50%";
        dot.style.background = cs.color;
        dot.style.boxShadow = "0 0 0 4px rgba(0,0,0,0.05)";
        card.appendChild(dot);
      }

      const clickable = !!takenBy && canClickColor(cs.color);
      card.disabled = !clickable;
      card.style.opacity = card.disabled ? "0.55" : "1";

      card.onclick = async () => {
         try {
          const { error } = await sb.rpc("pass_to_color", { p_code: roomCode, p_target_color: cs.color });
          if (error) throw error;

          // azonnali frissítés (Realtime nélkül is)
          await loadAll();
          render();
         } catch (e) {
          alertError(e);
         }
      };


      grid.appendChild(card);
    }

    // DM panel: overrides + slot locks
    if (IS_DM && !dmEditing) {
      const ovWrap =
        dmWrap.querySelector("#overrideGrid") ||
        dmWrap.querySelector("#dmOverrides");
      ovWrap.innerHTML = "";
      for (const cs of shownSlots) {
        const takenBy = players.find(p => p.color === cs.color);
        const ps = takenBy ? getPlayerState(takenBy.id) : null;

        const box = document.createElement("div");
        box.setAttribute("data-color", cs.color);
        box.style.border = "1px solid rgba(0,0,0,0.08)";
        box.style.borderRadius = "12px";
        box.style.padding = "10px";
        box.style.display = "grid";
        box.style.gap = "8px";

        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.justifyContent = "space-between";
        row.style.gap = "10px";

        const left = document.createElement("div");
        left.style.display = "flex";
        left.style.alignItems = "center";
        left.style.gap = "8px";
        const sw = document.createElement("div");
        sw.style.width = "14px";
        sw.style.height = "14px";
        sw.style.borderRadius = "6px";
        sw.style.background = cs.color;
        left.appendChild(sw);

        const t = document.createElement("div");
        t.style.fontWeight = "900";
        t.textContent = cs.color + (takenBy ? " • foglalt" : "");
        left.appendChild(t);
        row.appendChild(left);

        const inp = document.createElement("input");
        inp.placeholder = "egyéni idő (mm:ss)";
        inp.style.width = "140px";

        inp.addEventListener("focus", () => {
          DM_INPUT_ACTIVE = true;
        });

        inp.addEventListener("blur", () => {
          DM_INPUT_ACTIVE = false;

          const sec = parseMMSS(inp.value);
          if (sec == null) {
            delete dmOverrideDraft[cs.color];
            inp.value = "";
          } else {
            dmOverrideDraft[cs.color] = sec;
            inp.value = formatMMSS(sec);
          }
        });

        // korábbi érték visszatöltése
        if (dmOverrideDraft[cs.color] != null) {
          inp.value = formatMMSS(dmOverrideDraft[cs.color]);
        }

        // csak blur-re mentünk
        inp.addEventListener("blur", () => {
          const sec = parseMMSS(inp.value);
          if (sec == null) {
            delete dmOverrideDraft[cs.color];
            inp.value = "";
          } else {
            dmOverrideDraft[cs.color] = sec;
            inp.value = formatMMSS(sec);
          }
        });

        row.appendChild(inp);


        box.appendChild(row);

        const note = document.createElement("div");
        note.style.fontSize = "12px";
        note.style.opacity = ".7";
        note.textContent = ps ? `Aktuális base: ${formatMMSS(ps.base_seconds || 0)}` : "Nincs játékos ezen a színen";
        box.appendChild(note);

        ovWrap.appendChild(box);
      }

      const slotsWrap =
        dmWrap.querySelector("#slotsGrid") ||
        dmWrap.querySelector("#dmSlots");
      slotsWrap.innerHTML = "";

      // ===== A) SZÍNCSERE (két dropdown + gomb) =====
      {
        const occupied = [...new Set(players.map(p => p.color))].sort();
        if (occupied.length >= 2) {
          const box = document.createElement("div");
          box.style.display = "grid";
          box.style.gridTemplateColumns = "1fr 1fr auto";
          box.style.gap = "10px";
          box.style.alignItems = "center";
          box.style.marginBottom = "14px";

          const selA = document.createElement("select");
          const selB = document.createElement("select");

          const fill = (sel) => {
            sel.innerHTML = "";
            for (const c of occupied) {
              const o = document.createElement("option");
              o.value = c;
              o.textContent = ((colorSlots.find(s => s.color === c)?.display_name) || c);
              sel.appendChild(o);
            }
          };
          fill(selA); fill(selB);
          selA.value = occupied[0];
          selB.value = occupied[1];

          const btn = document.createElement("button");
          btn.className = "btn primary";
          btn.textContent = "CSERE";

          btn.onclick = async () => {
            try {
              // csak ha nincs futó timer és nincs combat
              if (roomState?.combat_active) throw new Error("HARC aktív, nem lehet cserélni.");
              if (roomState?.active_started_at) throw new Error("Timer fut, nem lehet cserélni (STOP előbb).");

              const a = selA.value;
              const b = selB.value;
              if (!a || !b || a === b) return;

              const { error } = await sb.rpc("dm_swap_colors", {
                p_code: roomCode,
                p_dm_token: DM_TOKEN,
                p_color_a: a,
                p_color_b: b
              });
              if (error) throw error;

              await loadAll();
              render();
            } catch (e) {
              alertError(e);
            }
          };

          box.appendChild(selA);
          box.appendChild(selB);
          box.appendChild(btn);

          const hint = document.createElement("div");
          hint.style.gridColumn = "1 / -1";
          hint.style.fontSize = "12px";
          hint.style.opacity = ".75";
          hint.textContent = "Színcsere csak foglalt színek között.";
          box.appendChild(hint);

          slotsWrap.appendChild(box);
        }
      }

      // ===== SZÍNNEVEK (DM felülírja red/blue...) =====
      {
        const title = document.createElement("div");
        title.style.fontWeight = "800";
        title.style.margin = "30px 100px 8px";
        title.textContent = "Színnevek:";
        slotsWrap.appendChild(title);

        for (const cs of shownSlots) {
          const row = document.createElement("div");
          row.style.display = "grid";

          // 2 oszlop, 2 sor: balra a szín (két sor magas), jobbra input, alatta mentés
          row.style.gridTemplateColumns = "50px 140px";
          row.style.gridTemplateRows = "auto auto";
          row.style.gap = "10px";
          row.style.alignItems = "center";
          row.style.marginBottom = "10px";

          const left = document.createElement("div");
          left.style.fontWeight = "800";
          left.textContent = cs.color;
          left.style.gridRow = "1 / span 2"; // két soron át
          left.style.alignSelf = "center";

          const inp = document.createElement("input");
          inp.type = "text";
          inp.placeholder = "pl. András";
          inp.value = (dmNameDraft[cs.color] ?? cs.display_name ?? "");
          inp.addEventListener("input", () => {
            dmNameDraft[cs.color] = inp.value;
          });
          inp.style.width = "140px";  

          const btn = document.createElement("button");
          btn.className = "btn";
          btn.textContent = "MENTÉS";
          btn.style.justifySelf = "start";     // ne lógjon a jobb szélre
          btn.style.width = "140px";           // kényelmesebb kattintás
          btn.style.marginTop = "2px";

          btn.onclick = async () => {
            try {
              const { error } = await sb.rpc("dm_set_color_name", {
                p_code: roomCode,
                p_dm_token: DM_TOKEN,
                p_color: cs.color,
                p_display_name: inp.value
              });

              if (error) {
                console.error("dm_set_color_name error:", error);
                alert(`Mentési hiba: ${error.message || JSON.stringify(error)}`);
                return;
              }

              delete dmNameDraft[cs.color];
              await loadAll();
              render();
            } catch (e) {
              alertError(e);
            }
          };

          row.appendChild(left);
          row.appendChild(inp);
          row.appendChild(btn);
          slotsWrap.appendChild(row);
        }
      }
    }
  }

  // ========= TICK =========
  function startTick() {
     // 1) folyamatos UI frissítés (hogy a másodpercek “folyjanak”)
     setInterval(() => {
       if (!roomState) return;
       render();
     }, 250);
   
     // 2) állapot szinkron (ha realtime nem működik / új játékos jön)
     setInterval(async () => {
       try {
         if (!roomId) return;
         await loadAll();
       } catch (e) {
         // ne zavarja a játékot, csak logoljuk
         console.warn("poll loadAll failed", e);
       }
     }, 1500);
   }


  // ========= BOOT =========
  (async () => {
    try {
      ensureUI();
      await ensureSession();

      // If no room param, show join card and hide game UI
      if (!ROOM_CODE) {
        if (el.joinCard) el.joinCard.classList.remove("hidden");
        showRoomLabel("Nincs szoba kiválasztva.");

        // rejtsük el a játék UI-t
        if (gridWrap) gridWrap.style.display = "none";
        if (dmWrap) dmWrap.style.display = "none";
        if (overlay) overlay.style.display = "none";

        // create gomb itt maradjon, szobán belül eltűnik (lásd lent)
        startTick();
        return;
      }


      // Resolve roomId by code (rooms table is not directly selectable)
      await resolveRoom(ROOM_CODE);

      // Join (auto-assign)
      await joinRoomAuto();

      // Load all
      await loadAll();

      // Realtime
      subscribeRealtime();

      // initial render + tick
      render();
      startTick();
    } catch (e) {
      fatal("Indítási hiba:\n" + (e?.message || String(e)));
      console.error(e);
    }
  })();
})();
