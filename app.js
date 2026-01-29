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
  let myPlayer = null; // player row

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

    // if no active running: only start own
    if (!roomState.active_player_id || !roomState.active_started_at) {
      return targetColor === myPlayer.color;
    }
    // if running: only active player can pass (to anyone)
    return roomState.active_player_id === myPlayer.id;
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
            <button id="btnStop" class="btn">STOP</button>
          </div>
        </div>
        <div id="grid" style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;"></div>
      `;
      ui.mainWrap.appendChild(gridWrap);
    }

    if (!dmWrap) {
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
          <div style="opacity:.7;font-size:12px;margin-bottom:10px;">
            Ha egy színt zárolsz és adsz join-kódot, a játékos csak a megfelelő kóddal tudja felvenni azt a színt.
          </div>
          <div id="dmSlots" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;"></div>
        </div>
      `;
      ui.mainWrap.appendChild(dmWrap);
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
    const btnStop = gridWrap.querySelector("#btnStop");
    const grid = gridWrap.querySelector("#grid");

    btnStop.onclick = async () => {
      // nincs külön stop RPC; a "pass_to_color" szabályaihoz igazodunk.
      // STOP-ot egyszerűen úgy csináljuk: átadjuk saját magunknak? Nem jó.
      // Ezért STOP-ot itt nem implementáljuk (SQL-ben nincs), csak DM fázis reset állítja le.
      alert("STOP funkció nincs bekötve (a jelenlegi SQL/RPC készletben nincs stop). Ha kell, írok hozzá RPC-t.");
    };

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

    // DM panel (a te index.html ID-jaival)
if (IS_DM) {
  // a te HTML-edben ez hidden class-szal van elrejtve
  const dmCard = document.getElementById("dmCard");
  if (dmCard) dmCard.classList.remove("hidden");

  const defaultInp = document.getElementById("defaultTimeInput");
  const btnNewPhase = document.getElementById("btnNewPhase");
  const overrideGrid = document.getElementById("overrideGrid");
  const dmMsg = document.getElementById("dmMsg");

  const setMsg = (t) => { if (dmMsg) dmMsg.textContent = t || ""; };

  if (btnNewPhase) {
    btnNewPhase.onclick = async () => {
      try {
        setMsg("");

        const def = parseMMSS(defaultInp?.value);
        if (def == null) throw new Error("Érvénytelen alapidő. Formátum: mm:ss (pl. 02:00).");

        // overrides a te overrideGrid-edből: inputok, amiknek data-color attribútuma van
        // (ha most nem ilyenek, akkor is működik: csak üres overrides lesz)
        const overrides = {};
        if (overrideGrid) {
          for (const inp of overrideGrid.querySelectorAll("input[data-color]")) {
            const color = String(inp.getAttribute("data-color") || "").trim();
            const sec = parseMMSS(inp.value);
            if (color && sec != null) overrides[color] = String(sec);
          }
        }

        await sb.rpc("dm_new_phase", {
          p_code: roomCode,
          p_dm_token: DM_TOKEN,
          p_default_seconds: def,
          p_overrides: overrides
        });

        setMsg("Új fázis elindítva.");
        defaultInp?.blur();
      } catch (e) {
        setMsg(e?.message || String(e));
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
    ensureUI();

    // Header label
    showRoomLabel(roomCode ? `Szoba: ${roomCode}${IS_DM ? " • DM" : ""}` : "Szoba: -");

    // joinCard visibility
    if (el.joinCard) {
      // if no ?room param -> show join; else hide
      el.joinCard.classList.toggle("hidden", !!ROOM_CODE);
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
      ovTitle.textContent = `HARC: ${init?.color || "?"} ↔ ${targ?.color || "?"}`;
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
      name.textContent = cs.color;
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
    if (IS_DM) {
      const ovWrap = dmWrap.querySelector("#dmOverrides");
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
        row.appendChild(inp);

        box.appendChild(row);

        const note = document.createElement("div");
        note.style.fontSize = "12px";
        note.style.opacity = ".7";
        note.textContent = ps ? `Aktuális base: ${formatMMSS(ps.base_seconds || 0)}` : "Nincs játékos ezen a színen";
        box.appendChild(note);

        ovWrap.appendChild(box);
      }

      const slotsWrap = dmWrap.querySelector("#dmSlots");
      slotsWrap.innerHTML = "";
      for (const cs of shownSlots) {
        const takenBy = players.find(p => p.color === cs.color);

        const box = document.createElement("div");
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

        const label = document.createElement("div");
        label.style.fontWeight = "900";
        label.textContent = cs.color;
        left.appendChild(label);

        row.appendChild(left);

        const status = document.createElement("div");
        status.style.fontSize = "12px";
        status.style.opacity = ".75";
        status.textContent = takenBy ? "FOGLALT" : (cs.locked ? "ZÁROLT" : "SZABAD");
        row.appendChild(status);

        box.appendChild(row);

        const row2 = document.createElement("div");
        row2.style.display = "grid";
        row2.style.gridTemplateColumns = "auto 1fr";
        row2.style.gap = "8px";
        row2.style.alignItems = "center";

        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = !!cs.locked;
        row2.appendChild(chk);

        const join = document.createElement("input");
        join.placeholder = "join-kód (opcionális)";
        row2.appendChild(join);

        box.appendChild(row2);

        const btn = document.createElement("button");
        btn.className = "btn";
        btn.textContent = "MENTÉS";
        btn.onclick = async () => {
          try {
            await sb.rpc("dm_set_color_slot", {
              p_code: roomCode,
              p_dm_token: DM_TOKEN,
              p_color: cs.color,
              p_locked: chk.checked,
              p_join_code: (join.value || "").trim() || null
            });
            join.value = "";
          } catch (e) {
            alertError(e);
          }
        };
        box.appendChild(btn);

        slotsWrap.appendChild(box);
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

      // If no room param, show join card and stop
      if (!ROOM_CODE) {
        if (el.joinCard) el.joinCard.classList.remove("hidden");
        showRoomLabel("Nincs szoba kiválasztva.");
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
