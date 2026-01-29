/* app.js
   Realtime “játékóra” kliens – Supabase + Netlify
   - dinamikusan felépíti a teljes UI-t (nem függ az index.html DOM-jától)
   - room link:  .../?room=ABCDEF
   - DM link:    .../?room=ABCDEF&dm=DM_TOKEN
*/

(() => {
  "use strict";

  // ====== CONFIG ======
  // Add meg a saját Supabase adataidat:
  const SUPABASE_URL = window.__SUPABASE_URL__ || "https://hjagqceimgujknfuyjwd.supabase.co";
  const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__ || "sb_publishable_NmqMqN6jb33gDn1qnyGU8w_45kWKwa-";

  // Játékos slotok (4–10)
  const MIN_SLOTS = 4;
  const MAX_SLOTS = 10;

  // Alap színek (10 db) – DM később átnevezheti / kioszthatja
  const DEFAULT_COLORS = [
    "#e53935", "#8e24aa", "#3949ab", "#1e88e5", "#00897b",
    "#43a047", "#f4511e", "#6d4c41", "#546e7a", "#f9a825"
  ];

  // ====== URL PARAMS ======
  const url = new URL(window.location.href);
  const ROOM_CODE = (url.searchParams.get("room") || "").trim();
  const DM_TOKEN = (url.searchParams.get("dm") || "").trim();
  const IS_DM = !!DM_TOKEN;

  // ====== SUPABASE CLIENT ======
  if (!window.supabase) {
    fatal("A Supabase JS kliens nincs betöltve. Ellenőrizd az index.html-ben a supabase-js CDN scriptet.");
    return;
  }
  if (!ROOM_CODE) {
    fatal("Hiányzó room paraméter. Használd így: ?room=ABCDEF (DM: &dm=TOKEN).");
    return;
  }
  if (SUPABASE_URL.includes("PASTE_") || SUPABASE_ANON_KEY.includes("PASTE_")) {
    fatal("Nincs beállítva SUPABASE_URL / SUPABASE_ANON_KEY az app.js-ben.");
    return;
  }

  const { createClient } = window.supabase;
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });

  // ====== STATE (client-side) ======
  let session = null;
  let userId = null;

  /** Room rekord, elvárt mezők:
   * rooms: { id, code, dm_token_hash? (opcionális), state(jsonb), created_at }
   * state: {
   *   phase_index: number,
   *   is_running: boolean,
   *   active_slot: number|null,
   *   started_at: string|null,        // ISO
   *   phase_default_seconds: number,  // pl. 120
   *   combat: {
   *     active: boolean,
   *     started_at: string|null,
   *     initiator_slot: number|null,
   *     target_slot: number|null
   *   }
   * }
   */
  let room = null;

  /** player_slots rekordok, elvárt mezők:
   * player_slots: {
   *   room_id, slot, color, label,
   *   user_id,                 // kiosztott user (anonymous)
   *   base_seconds,            // adott fázisban induló idő (DM állítja; lehet egyéni)
   *   spent_seconds,           // az adott fázisban eddig elhasznált idő
   *   updated_at
   * }
   */
  let slots = [];

  // UI refs
  const ui = {};
  let realtimeRoomChannel = null;
  let realtimeSlotsChannel = null;

  // rendering throttle
  let renderQueued = false;

  // ====== HELPERS ======
  function fatal(msg) {
    document.body.innerHTML = "";
    const box = document.createElement("div");
    box.style.maxWidth = "900px";
    box.style.margin = "40px auto";
    box.style.padding = "16px";
    box.style.border = "1px solid #d33";
    box.style.borderRadius = "12px";
    box.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial";
    box.style.whiteSpace = "pre-wrap";
    box.textContent = msg;
    document.body.appendChild(box);
  }

  function nowMs() { return Date.now(); }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function pad2(n) {
    const s = String(Math.floor(Math.abs(n)));
    return s.length === 1 ? "0" + s : s;
  }

  function formatMMSS(totalSeconds) {
    totalSeconds = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${pad2(m)}:${pad2(s)}`;
  }

  function parseMMSS(input) {
    // Accept: "mm:ss" or "m:ss" or "ss" or "hh:mm:ss" (we'll take last 2 as mm:ss)
    const t = String(input || "").trim();
    if (!t) return null;

    const parts = t.split(":").map(p => p.trim()).filter(Boolean);
    if (parts.length === 1) {
      const s = Number(parts[0]);
      if (!Number.isFinite(s) || s < 0) return null;
      return Math.floor(s);
    }
    if (parts.length === 2) {
      const m = Number(parts[0]);
      const s = Number(parts[1]);
      if (![m, s].every(Number.isFinite) || m < 0 || s < 0 || s >= 60) return null;
      return Math.floor(m * 60 + s);
    }
    if (parts.length === 3) {
      // hh:mm:ss → convert to seconds, but display remains mm:ss in UI; still ok for storage
      const h = Number(parts[0]);
      const m = Number(parts[1]);
      const s = Number(parts[2]);
      if (![h, m, s].every(Number.isFinite) || h < 0 || m < 0 || s < 0 || m >= 60 || s >= 60) return null;
      return Math.floor(h * 3600 + m * 60 + s);
    }
    return null;
  }

  function safeState() {
    const st = (room && room.state) ? room.state : {};
    st.phase_index = Number.isFinite(st.phase_index) ? st.phase_index : 0;
    st.is_running = !!st.is_running;
    st.active_slot = (Number.isFinite(st.active_slot) ? st.active_slot : null);
    st.started_at = st.started_at || null;
    st.phase_default_seconds = Number.isFinite(st.phase_default_seconds) ? st.phase_default_seconds : 120;
    st.combat = st.combat || {};
    st.combat.active = !!st.combat.active;
    st.combat.started_at = st.combat.started_at || null;
    st.combat.initiator_slot = Number.isFinite(st.combat.initiator_slot) ? st.combat.initiator_slot : null;
    st.combat.target_slot = Number.isFinite(st.combat.target_slot) ? st.combat.target_slot : null;
    return st;
  }

  function getSlot(slotNum) {
    return slots.find(s => s.slot === slotNum) || null;
  }

  function mySlot() {
    return slots.find(s => s.user_id === userId) || null;
  }

  function computeSpentWithRunning(slotRec) {
    const st = safeState();
    const baseSpent = Number.isFinite(slotRec.spent_seconds) ? slotRec.spent_seconds : 0;

    if (st.combat.active) {
      // combat alatt nem telik senki ideje
      return baseSpent;
    }

    if (!st.is_running || st.active_slot == null || !st.started_at) {
      return baseSpent;
    }

    if (slotRec.slot !== st.active_slot) {
      return baseSpent;
    }

    const startedMs = Date.parse(st.started_at);
    if (!Number.isFinite(startedMs)) return baseSpent;
    const delta = Math.max(0, Math.floor((nowMs() - startedMs) / 1000));
    return baseSpent + delta;
  }

  function computeRemaining(slotRec) {
    const base = Number.isFinite(slotRec.base_seconds) ? slotRec.base_seconds : safeState().phase_default_seconds;
    const spent = computeSpentWithRunning(slotRec);
    return Math.max(0, base - spent);
  }

  function combatRemainingSeconds() {
    const st = safeState();
    if (!st.combat.active || !st.combat.started_at) return null;
    const startedMs = Date.parse(st.combat.started_at);
    if (!Number.isFinite(startedMs)) return null;
    const elapsed = Math.max(0, Math.floor((nowMs() - startedMs) / 1000));
    return Math.max(0, 60 - elapsed);
  }

  function canClickSlot(slotNum) {
    const st = safeState();
    if (st.combat.active) return false;
    const me = mySlot();
    if (!me) return false;
    // csak az aktív adhat tovább
    if (!st.is_running || st.active_slot == null) {
      // ha senki sem fut, akkor bárki elindíthatja a sajátját
      return slotNum === me.slot;
    }
    // ha fut, akkor csak az aktív kattinthat, és választhat bárkit (slot váltás)
    return me.slot === st.active_slot;
  }

  function canStartCombat() {
    const st = safeState();
    if (st.combat.active) return false;
    const me = mySlot();
    if (!me) return false;
    return st.is_running && st.active_slot === me.slot;
  }

  function canEndCombat() {
    const st = safeState();
    if (!st.combat.active) return false;
    const me = mySlot();
    if (!me) return false;
    return st.combat.initiator_slot === me.slot || IS_DM;
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  // ====== DATA ACCESS LAYER ======
  async function ensureSession() {
    const { data: s1, error: e1 } = await sb.auth.getSession();
    if (e1) throw e1;
    if (s1.session) {
      session = s1.session;
    } else {
      const { data: s2, error: e2 } = await sb.auth.signInAnonymously();
      if (e2) throw e2;
      session = s2.session;
    }
    userId = session.user.id;
  }

  async function loadRoom() {
    const { data, error } = await sb
      .from("rooms")
      .select("*")
      .eq("code", ROOM_CODE)
      .single();
    if (error) throw error;
    room = data;
  }

  async function loadSlots() {
    const { data, error } = await sb
      .from("player_slots")
      .select("*")
      .eq("room_id", room.id)
      .order("slot", { ascending: true });
    if (error) throw error;
    slots = data || [];
  }

  async function joinOrRestoreMySlot() {
    // Ha van már user_id-hez slot, akkor kész.
    let mine = slots.find(s => s.user_id === userId);
    if (mine) return;

    // Keress szabad slotot (user_id null)
    const free = slots.find(s => !s.user_id);
    if (!free) {
      // ha nincs előre létrehozva slot, próbálj létrehozni max-ig
      // (ha a backend nem engedi, akkor hibát dob; ez oké)
      const need = clamp(MAX_SLOTS, MIN_SLOTS, MAX_SLOTS);
      if (slots.length < need) {
        const inserts = [];
        for (let i = slots.length + 1; i <= need; i++) {
          inserts.push({
            room_id: room.id,
            slot: i,
            color: DEFAULT_COLORS[i - 1] || "#777",
            label: `J${i}`,
            user_id: null,
            base_seconds: safeState().phase_default_seconds,
            spent_seconds: 0
          });
        }
        const { error: insErr } = await sb.from("player_slots").insert(inserts);
        if (insErr) throw insErr;
        await loadSlots();
      }
    }

    // újra keress szabadot
    const free2 = slots.find(s => !s.user_id);
    if (!free2) {
      throw new Error("Nincs szabad szín/slot ebben a szobában.");
    }

    const { error: upErr } = await sb
      .from("player_slots")
      .update({ user_id: userId })
      .eq("room_id", room.id)
      .eq("slot", free2.slot);

    if (upErr) throw upErr;
    await loadSlots();
  }

  // ---- Actions: prefer RPC if exists, fallback to direct updates ----

  async function rpcOrFallback(name, args, fallbackFn) {
    const { data, error } = await sb.rpc(name, args);
    if (!error) return data;
    // fallback only if RPC missing
    const msg = String(error.message || "");
    const isMissing = msg.toLowerCase().includes("function") && msg.toLowerCase().includes("does not exist");
    if (!isMissing) throw error;
    if (!fallbackFn) throw error;
    return await fallbackFn();
  }

  async function actionStartOrSwitchToSlot(targetSlot) {
    // Switch semantics:
    // - if someone running: add elapsed to previous active slot.spent_seconds, stop it
    // - start target slot as active with started_at = now
    // - if no one running: just start target
    await rpcOrFallback(
      "start_or_switch_slot",
      { p_room_code: ROOM_CODE, p_target_slot: targetSlot },
      async () => {
        // Fallback (non-atomic): best effort.
        const st = safeState();
        const nowIso = new Date().toISOString();

        // if combat active -> refuse
        if (st.combat.active) return;

        // finalize previous running
        if (st.is_running && st.active_slot != null && st.started_at) {
          const prevSlot = st.active_slot;
          const prev = getSlot(prevSlot);
          if (prev) {
            const startedMs = Date.parse(st.started_at);
            const delta = Number.isFinite(startedMs) ? Math.max(0, Math.floor((nowMs() - startedMs) / 1000)) : 0;
            const newSpent = (Number.isFinite(prev.spent_seconds) ? prev.spent_seconds : 0) + delta;
            await sb
              .from("player_slots")
              .update({ spent_seconds: newSpent })
              .eq("room_id", room.id)
              .eq("slot", prevSlot);
          }
        }

        // start target
        const newState = {
          ...st,
          is_running: true,
          active_slot: targetSlot,
          started_at: nowIso
        };
        const { error: rErr } = await sb
          .from("rooms")
          .update({ state: newState })
          .eq("id", room.id);
        if (rErr) throw rErr;
      }
    );
  }

  async function actionStopRunning() {
    await rpcOrFallback(
      "stop_running",
      { p_room_code: ROOM_CODE },
      async () => {
        const st = safeState();
        if (!st.is_running || st.active_slot == null || !st.started_at) return;

        // finalize active spent
        const activeSlot = st.active_slot;
        const active = getSlot(activeSlot);
        if (active) {
          const startedMs = Date.parse(st.started_at);
          const delta = Number.isFinite(startedMs) ? Math.max(0, Math.floor((nowMs() - startedMs) / 1000)) : 0;
          const newSpent = (Number.isFinite(active.spent_seconds) ? active.spent_seconds : 0) + delta;
          await sb
            .from("player_slots")
            .update({ spent_seconds: newSpent })
            .eq("room_id", room.id)
            .eq("slot", activeSlot);
        }

        const newState = { ...st, is_running: false, active_slot: null, started_at: null };
        const { error } = await sb.from("rooms").update({ state: newState }).eq("id", room.id);
        if (error) throw error;
      }
    );
  }

  async function actionBeginCombat(targetSlot) {
    await rpcOrFallback(
      "begin_combat",
      { p_room_code: ROOM_CODE, p_target_slot: targetSlot },
      async () => {
        const st = safeState();
        if (!st.is_running || st.active_slot == null || !st.started_at) return;
        if (st.combat.active) return;

        // finalize active spent up to combat start (since we "pause")
        const activeSlot = st.active_slot;
        const active = getSlot(activeSlot);
        if (active) {
          const startedMs = Date.parse(st.started_at);
          const delta = Number.isFinite(startedMs) ? Math.max(0, Math.floor((nowMs() - startedMs) / 1000)) : 0;
          const newSpent = (Number.isFinite(active.spent_seconds) ? active.spent_seconds : 0) + delta;
          await sb
            .from("player_slots")
            .update({ spent_seconds: newSpent })
            .eq("room_id", room.id)
            .eq("slot", activeSlot);
        }

        // keep running state but set started_at to now to avoid double-count; and combat active
        const nowIso = new Date().toISOString();
        const newState = {
          ...st,
          started_at: nowIso, // baseline after combat ends
          combat: {
            active: true,
            started_at: nowIso,
            initiator_slot: activeSlot,
            target_slot: targetSlot
          }
        };
        const { error } = await sb.from("rooms").update({ state: newState }).eq("id", room.id);
        if (error) throw error;
      }
    );
  }

  async function actionEndCombat() {
    await rpcOrFallback(
      "end_combat",
      { p_room_code: ROOM_CODE },
      async () => {
        const st = safeState();
        if (!st.combat.active) return;

        // End combat, resume running for initiator slot.
        const nowIso = new Date().toISOString();
        const initiator = st.combat.initiator_slot;

        const newState = {
          ...st,
          combat: {
            active: false,
            started_at: null,
            initiator_slot: null,
            target_slot: null
          },
          // keep running on initiator
          is_running: true,
          active_slot: initiator,
          started_at: nowIso
        };

        const { error } = await sb.from("rooms").update({ state: newState }).eq("id", room.id);
        if (error) throw error;
      }
    );
  }

  async function dmResetPhase(defaultSeconds, perSlotSecondsMap) {
    // defaultSeconds: number
    // perSlotSecondsMap: { [slotNum]: seconds } optional
    await rpcOrFallback(
      "dm_reset_phase",
      {
        p_room_code: ROOM_CODE,
        p_dm_token: DM_TOKEN,
        p_default_seconds: defaultSeconds,
        p_slot_seconds: perSlotSecondsMap || {}
      },
      async () => {
        // Fallback: client-side checks only; backend MUST enforce in RLS in a real deployment.
        if (!IS_DM) throw new Error("Nem DM.");

        // stop running, clear combat, bump phase_index, set default
        const st = safeState();
        const newState = {
          ...st,
          phase_index: (st.phase_index || 0) + 1,
          phase_default_seconds: defaultSeconds,
          is_running: false,
          active_slot: null,
          started_at: null,
          combat: { active: false, started_at: null, initiator_slot: null, target_slot: null }
        };

        // update room
        {
          const { error } = await sb.from("rooms").update({ state: newState }).eq("id", room.id);
          if (error) throw error;
        }

        // reset slots: spent_seconds=0, base_seconds=default or per-slot override
        for (const s of slots) {
          const base = (perSlotSecondsMap && Number.isFinite(perSlotSecondsMap[s.slot]))
            ? perSlotSecondsMap[s.slot]
            : defaultSeconds;
          const { error } = await sb
            .from("player_slots")
            .update({ spent_seconds: 0, base_seconds: base })
            .eq("room_id", room.id)
            .eq("slot", s.slot);
          if (error) throw error;
        }
      }
    );
  }

  async function dmAssignSlot(slotNum, newUserIdOrNull) {
    await rpcOrFallback(
      "dm_assign_slot",
      { p_room_code: ROOM_CODE, p_dm_token: DM_TOKEN, p_slot: slotNum, p_user_id: newUserIdOrNull },
      async () => {
        if (!IS_DM) throw new Error("Nem DM.");
        const { error } = await sb
          .from("player_slots")
          .update({ user_id: newUserIdOrNull })
          .eq("room_id", room.id)
          .eq("slot", slotNum);
        if (error) throw error;
      }
    );
  }

  async function dmSetSlotLabel(slotNum, label) {
    await rpcOrFallback(
      "dm_set_slot_label",
      { p_room_code: ROOM_CODE, p_dm_token: DM_TOKEN, p_slot: slotNum, p_label: label },
      async () => {
        if (!IS_DM) throw new Error("Nem DM.");
        const { error } = await sb
          .from("player_slots")
          .update({ label })
          .eq("room_id", room.id)
          .eq("slot", slotNum);
        if (error) throw error;
      }
    );
  }

  async function dmSetSlotColor(slotNum, color) {
    await rpcOrFallback(
      "dm_set_slot_color",
      { p_room_code: ROOM_CODE, p_dm_token: DM_TOKEN, p_slot: slotNum, p_color: color },
      async () => {
        if (!IS_DM) throw new Error("Nem DM.");
        const { error } = await sb
          .from("player_slots")
          .update({ color })
          .eq("room_id", room.id)
          .eq("slot", slotNum);
        if (error) throw error;
      }
    );
  }

  // ====== REALTIME ======
  function subscribeRealtime() {
    // Rooms updates
    realtimeRoomChannel = sb
      .channel(`room:${ROOM_CODE}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: `id=eq.${room.id}` },
        (payload) => {
          if (payload.new) room = payload.new;
          queueRender();
        }
      )
      .subscribe();

    // Slots updates
    realtimeSlotsChannel = sb
      .channel(`slots:${ROOM_CODE}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "player_slots", filter: `room_id=eq.${room.id}` },
        async () => {
          // reload full list to avoid dealing with merge edge cases
          try {
            await loadSlots();
            queueRender();
          } catch (e) {
            console.error(e);
          }
        }
      )
      .subscribe();
  }

  // ====== UI BUILD ======
  function buildUI() {
    document.body.innerHTML = "";
    document.body.style.margin = "0";
    document.body.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial";

    const root = document.createElement("div");
    root.style.maxWidth = "1100px";
    root.style.margin = "0 auto";
    root.style.padding = "16px";
    root.style.display = "grid";
    root.style.gridTemplateColumns = "1fr";
    root.style.gap = "12px";
    document.body.appendChild(root);

    // Header
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "12px";
    root.appendChild(header);

    const title = document.createElement("div");
    title.innerHTML = `<div style="font-size:18px;font-weight:700;">Játékóra</div>
                       <div style="opacity:.7;font-size:12px;">Szoba: <b>${escapeHtml(ROOM_CODE)}</b>${IS_DM ? " • DM" : ""}</div>`;
    header.appendChild(title);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "8px";
    header.appendChild(right);

    ui.btnCombat = document.createElement("button");
    ui.btnCombat.textContent = "HARC";
    ui.btnCombat.style.padding = "10px 14px";
    ui.btnCombat.style.borderRadius = "10px";
    ui.btnCombat.style.border = "1px solid #ccc";
    ui.btnCombat.style.cursor = "pointer";
    right.appendChild(ui.btnCombat);

    ui.btnStop = document.createElement("button");
    ui.btnStop.textContent = "STOP";
    ui.btnStop.style.padding = "10px 14px";
    ui.btnStop.style.borderRadius = "10px";
    ui.btnStop.style.border = "1px solid #ccc";
    ui.btnStop.style.cursor = "pointer";
    right.appendChild(ui.btnStop);

    // Players grid
    ui.grid = document.createElement("div");
    ui.grid.style.display = "grid";
    ui.grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(160px, 1fr))";
    ui.grid.style.gap = "10px";
    root.appendChild(ui.grid);

    // DM panel
    ui.dmPanel = document.createElement("div");
    ui.dmPanel.style.border = "1px solid #ddd";
    ui.dmPanel.style.borderRadius = "12px";
    ui.dmPanel.style.padding = "12px";
    ui.dmPanel.style.display = IS_DM ? "grid" : "none";
    ui.dmPanel.style.gap = "10px";
    root.appendChild(ui.dmPanel);

    if (IS_DM) {
      const dmTitle = document.createElement("div");
      dmTitle.innerHTML = `<div style="font-weight:700;">DM</div>
                           <div style="opacity:.7;font-size:12px;">Új fázis + idő beállítás, színkiosztás</div>`;
      ui.dmPanel.appendChild(dmTitle);

      // Phase duration
      const row1 = document.createElement("div");
      row1.style.display = "grid";
      row1.style.gridTemplateColumns = "1fr auto";
      row1.style.gap = "10px";
      ui.dmPanel.appendChild(row1);

      ui.dmDefaultInput = document.createElement("input");
      ui.dmDefaultInput.placeholder = "Alapidő (mm:ss) pl. 02:00";
      ui.dmDefaultInput.style.padding = "10px 12px";
      ui.dmDefaultInput.style.borderRadius = "10px";
      ui.dmDefaultInput.style.border = "1px solid #ccc";
      row1.appendChild(ui.dmDefaultInput);

      ui.dmApplyBtn = document.createElement("button");
      ui.dmApplyBtn.textContent = "ÚJ FÁZIS / RESET";
      ui.dmApplyBtn.style.padding = "10px 14px";
      ui.dmApplyBtn.style.borderRadius = "10px";
      ui.dmApplyBtn.style.border = "1px solid #ccc";
      ui.dmApplyBtn.style.cursor = "pointer";
      row1.appendChild(ui.dmApplyBtn);

      // Per-player overrides
      ui.dmPerPlayerWrap = document.createElement("div");
      ui.dmPerPlayerWrap.style.display = "grid";
      ui.dmPerPlayerWrap.style.gridTemplateColumns = "repeat(auto-fit, minmax(220px, 1fr))";
      ui.dmPerPlayerWrap.style.gap = "10px";
      ui.dmPanel.appendChild(ui.dmPerPlayerWrap);

      // Slot assignment section
      ui.dmAssignWrap = document.createElement("div");
      ui.dmAssignWrap.style.borderTop = "1px solid #eee";
      ui.dmAssignWrap.style.paddingTop = "10px";
      ui.dmAssignWrap.style.display = "grid";
      ui.dmAssignWrap.style.gap = "8px";
      ui.dmPanel.appendChild(ui.dmAssignWrap);

      const hint = document.createElement("div");
      hint.style.opacity = ".75";
      hint.style.fontSize = "12px";
      hint.textContent =
        "Színkiosztás: a játékosok automatikusan foglalnak szabad slotot. Itt tudod felszabadítani vagy fixálni (pl. újratöltési problémákra).";
      ui.dmAssignWrap.appendChild(hint);

      ui.dmAssignList = document.createElement("div");
      ui.dmAssignList.style.display = "grid";
      ui.dmAssignList.style.gridTemplateColumns = "repeat(auto-fit, minmax(260px, 1fr))";
      ui.dmAssignList.style.gap = "10px";
      ui.dmAssignWrap.appendChild(ui.dmAssignList);
    }

    // Overlay (combat)
    ui.overlay = document.createElement("div");
    ui.overlay.style.position = "fixed";
    ui.overlay.style.left = "0";
    ui.overlay.style.top = "0";
    ui.overlay.style.right = "0";
    ui.overlay.style.padding = "14px 16px";
    ui.overlay.style.background = "rgba(0,0,0,0.85)";
    ui.overlay.style.color = "white";
    ui.overlay.style.display = "none";
    ui.overlay.style.zIndex = "1000";
    ui.overlay.style.backdropFilter = "blur(2px)";
    ui.overlay.style.borderBottom = "1px solid rgba(255,255,255,0.15)";
    document.body.appendChild(ui.overlay);

    const ovRow = document.createElement("div");
    ovRow.style.display = "flex";
    ovRow.style.alignItems = "center";
    ovRow.style.justifyContent = "space-between";
    ovRow.style.gap = "10px";
    ui.overlay.appendChild(ovRow);

    ui.overlayLeft = document.createElement("div");
    ui.overlayLeft.style.display = "grid";
    ui.overlayLeft.style.gap = "4px";
    ovRow.appendChild(ui.overlayLeft);

    ui.overlayTitle = document.createElement("div");
    ui.overlayTitle.style.fontWeight = "800";
    ui.overlayTitle.style.fontSize = "16px";
    ui.overlayLeft.appendChild(ui.overlayTitle);

    ui.overlayTimer = document.createElement("div");
    ui.overlayTimer.style.fontSize = "28px";
    ui.overlayTimer.style.fontWeight = "900";
    ui.overlayLeft.appendChild(ui.overlayTimer);

    ui.overlayEnd = document.createElement("button");
    ui.overlayEnd.textContent = "VÉGE";
    ui.overlayEnd.style.padding = "10px 14px";
    ui.overlayEnd.style.borderRadius = "10px";
    ui.overlayEnd.style.border = "1px solid rgba(255,255,255,0.35)";
    ui.overlayEnd.style.background = "transparent";
    ui.overlayEnd.style.color = "white";
    ui.overlayEnd.style.cursor = "pointer";
    ovRow.appendChild(ui.overlayEnd);

    // Handlers
    ui.btnStop.onclick = async () => {
      try {
        await actionStopRunning();
      } catch (e) {
        alertError(e);
      }
    };

    ui.btnCombat.onclick = async () => {
      try {
        if (!canStartCombat()) return;
        // pick target slot
        const target = await pickTargetSlotDialog();
        if (target == null) return;
        await actionBeginCombat(target);
      } catch (e) {
        alertError(e);
      }
    };

    ui.overlayEnd.onclick = async () => {
      try {
        if (!canEndCombat()) return;
        await actionEndCombat();
      } catch (e) {
        alertError(e);
      }
    };

    if (IS_DM) {
      ui.dmApplyBtn.onclick = async () => {
        try {
          const d = parseMMSS(ui.dmDefaultInput.value);
          if (d == null) throw new Error("Érvénytelen idő. Formátum: mm:ss (pl. 02:00).");
          const per = collectPerSlotOverrides();
          await dmResetPhase(d, per);
          ui.dmDefaultInput.blur();
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function collectPerSlotOverrides() {
    if (!IS_DM) return {};
    const map = {};
    const items = ui.dmPerPlayerWrap.querySelectorAll("[data-slot-override]");
    for (const it of items) {
      const slot = Number(it.getAttribute("data-slot-override"));
      const inp = it.querySelector("input");
      const v = parseMMSS(inp.value);
      if (v != null) map[slot] = v;
    }
    return map;
  }

  async function pickTargetSlotDialog() {
    // Simple native dialog: list available slot labels
    const st = safeState();
    const me = mySlot();
    const choices = slots
      .filter(s => s.slot !== st.active_slot)
      .map(s => ({
        slot: s.slot,
        label: (s.label || `J${s.slot}`) + ` (${formatMMSS(computeRemaining(s))})`
      }));

    if (!choices.length) return null;

    const text =
      "Válassz célpontot (írd be a sorszámot):\n" +
      choices.map((c, i) => `${i + 1}. ${c.label}`).join("\n");

    const ans = prompt(text, "1");
    if (ans == null) return null;
    const idx = Number(ans.trim());
    if (!Number.isFinite(idx) || idx < 1 || idx > choices.length) return null;
    return choices[idx - 1].slot;
  }

  // ====== RENDER ======
  function render() {
    const st = safeState();

    // Combat overlay
    if (st.combat.active) {
      ui.overlay.style.display = "block";
      const initiator = getSlot(st.combat.initiator_slot);
      const target = getSlot(st.combat.target_slot);
      const initName = initiator ? (initiator.label || `J${initiator.slot}`) : "Ismeretlen";
      const targName = target ? (target.label || `J${target.slot}`) : "Ismeretlen";
      ui.overlayTitle.textContent = `HARC: ${initName} ↔ ${targName}`;
      const rem = combatRemainingSeconds();
      ui.overlayTimer.textContent = rem == null ? "01:00" : formatMMSS(rem);
      ui.overlayEnd.disabled = !canEndCombat();
      ui.overlayEnd.style.opacity = ui.overlayEnd.disabled ? "0.5" : "1";
    } else {
      ui.overlay.style.display = "none";
    }

    // Buttons availability
    ui.btnCombat.disabled = !canStartCombat();
    ui.btnCombat.style.opacity = ui.btnCombat.disabled ? "0.5" : "1";

    // STOP: allow only if (a) DM or (b) active user
    const me = mySlot();
    const stopAllowed = IS_DM || (me && st.is_running && st.active_slot === me.slot);
    ui.btnStop.disabled = !stopAllowed || st.combat.active;
    ui.btnStop.style.opacity = ui.btnStop.disabled ? "0.5" : "1";

    // Grid
    clear(ui.grid);

    // Ensure slot count at least MIN_SLOTS when rendering, but only show existing records
    const shown = slots.slice(0, clamp(slots.length, MIN_SLOTS, MAX_SLOTS));

    for (const s of shown) {
      const card = document.createElement("button");
      card.type = "button";
      card.style.border = "1px solid #ddd";
      card.style.borderRadius = "14px";
      card.style.padding = "12px";
      card.style.textAlign = "left";
      card.style.cursor = "pointer";
      card.style.background = "white";
      card.style.display = "grid";
      card.style.gap = "8px";
      card.style.userSelect = "none";
      card.style.position = "relative";

      // color bar
      const bar = document.createElement("div");
      bar.style.height = "10px";
      bar.style.borderRadius = "999px";
      bar.style.background = s.color || "#777";
      card.appendChild(bar);

      const top = document.createElement("div");
      top.style.display = "flex";
      top.style.alignItems = "baseline";
      top.style.justifyContent = "space-between";
      top.style.gap = "10px";
      card.appendChild(top);

      const name = document.createElement("div");
      name.style.fontWeight = "800";
      name.textContent = s.label || `J${s.slot}`;
      top.appendChild(name);

      const badge = document.createElement("div");
      badge.style.fontSize = "12px";
      badge.style.opacity = "0.75";
      badge.textContent = s.user_id ? (s.user_id === userId ? "TE" : "FOGLALT") : "SZABAD";
      top.appendChild(badge);

      const time = document.createElement("div");
      time.style.fontSize = "34px";
      time.style.fontWeight = "900";
      time.textContent = formatMMSS(computeRemaining(s));
      card.appendChild(time);

      // running indicator
      const isActive = st.is_running && st.active_slot === s.slot && !st.combat.active;
      if (isActive) {
        const dot = document.createElement("div");
        dot.style.position = "absolute";
        dot.style.right = "12px";
        dot.style.top = "12px";
        dot.style.width = "12px";
        dot.style.height = "12px";
        dot.style.borderRadius = "50%";
        dot.style.background = s.color || "#0a0";
        dot.style.boxShadow = "0 0 0 4px rgba(0,0,0,0.05)";
        card.appendChild(dot);
      }

      // Click behavior:
      // - if no one running: only your own slot can start
      // - if running: only active can switch to another slot
      const clickable = canClickSlot(s.slot) && !st.combat.active;
      card.disabled = !clickable;
      card.style.opacity = card.disabled ? "0.55" : "1";

      card.onclick = async () => {
        try {
          if (st.combat.active) return;
          await actionStartOrSwitchToSlot(s.slot);
        } catch (e) {
          alertError(e);
        }
      };

      ui.grid.appendChild(card);
    }

    // DM panel per-slot overrides + assignment list
    if (IS_DM) {
      // Default duration placeholder = current
      ui.dmDefaultInput.placeholder = `Alapidő (mm:ss) pl. ${formatMMSS(st.phase_default_seconds)}`;

      // Per-player overrides
      clear(ui.dmPerPlayerWrap);
      for (const s of shown) {
        const box = document.createElement("div");
        box.setAttribute("data-slot-override", String(s.slot));
        box.style.border = "1px solid #eee";
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
        const c = document.createElement("div");
        c.style.width = "14px";
        c.style.height = "14px";
        c.style.borderRadius = "6px";
        c.style.background = s.color || "#777";
        left.appendChild(c);
        const t = document.createElement("div");
        t.style.fontWeight = "800";
        t.textContent = s.label || `J${s.slot}`;
        left.appendChild(t);

        row.appendChild(left);

        const inp = document.createElement("input");
        inp.placeholder = `egyéni idő (mm:ss)`;
        inp.style.padding = "8px 10px";
        inp.style.borderRadius = "10px";
        inp.style.border = "1px solid #ccc";
        inp.style.width = "140px";
        row.appendChild(inp);

        box.appendChild(row);

        const note = document.createElement("div");
        note.style.fontSize = "12px";
        note.style.opacity = ".7";
        note.textContent = `Aktuális base: ${formatMMSS(Number.isFinite(s.base_seconds) ? s.base_seconds : st.phase_default_seconds)}`;
        box.appendChild(note);

        ui.dmPerPlayerWrap.appendChild(box);
      }

      // Assignment list
      clear(ui.dmAssignList);
      for (const s of shown) {
        const box = document.createElement("div");
        box.style.border = "1px solid #eee";
        box.style.borderRadius = "12px";
        box.style.padding = "10px";
        box.style.display = "grid";
        box.style.gap = "8px";

        const top = document.createElement("div");
        top.style.display = "flex";
        top.style.alignItems = "center";
        top.style.justifyContent = "space-between";
        top.style.gap = "10px";
        box.appendChild(top);

        const left = document.createElement("div");
        left.style.display = "flex";
        left.style.alignItems = "center";
        left.style.gap = "8px";
        const c = document.createElement("div");
        c.style.width = "14px";
        c.style.height = "14px";
        c.style.borderRadius = "6px";
        c.style.background = s.color || "#777";
        left.appendChild(c);
        const lab = document.createElement("div");
        lab.style.fontWeight = "800";
        lab.textContent = `Slot ${s.slot}`;
        left.appendChild(lab);
        top.appendChild(left);

        const status = document.createElement("div");
        status.style.fontSize = "12px";
        status.style.opacity = ".75";
        status.textContent = s.user_id ? "FOGLALT" : "SZABAD";
        top.appendChild(status);

        const r1 = document.createElement("div");
        r1.style.display = "grid";
        r1.style.gridTemplateColumns = "1fr 1fr";
        r1.style.gap = "8px";
        box.appendChild(r1);

        const nameInp = document.createElement("input");
        nameInp.value = s.label || `J${s.slot}`;
        nameInp.style.padding = "8px 10px";
        nameInp.style.borderRadius = "10px";
        nameInp.style.border = "1px solid #ccc";
        nameInp.title = "Címke";
        r1.appendChild(nameInp);

        const colorInp = document.createElement("input");
        colorInp.type = "color";
        colorInp.value = normalizeHexColor(s.color) || "#777777";
        colorInp.style.height = "38px";
        colorInp.style.borderRadius = "10px";
        colorInp.style.border = "1px solid #ccc";
        r1.appendChild(colorInp);

        const r2 = document.createElement("div");
        r2.style.display = "grid";
        r2.style.gridTemplateColumns = "1fr 1fr";
        r2.style.gap = "8px";
        box.appendChild(r2);

        const btnSave = document.createElement("button");
        btnSave.textContent = "MENTÉS";
        btnSave.style.padding = "8px 10px";
        btnSave.style.borderRadius = "10px";
        btnSave.style.border = "1px solid #ccc";
        btnSave.style.cursor = "pointer";
        r2.appendChild(btnSave);

        const btnFree = document.createElement("button");
        btnFree.textContent = "FELSZABADÍT";
        btnFree.style.padding = "8px 10px";
        btnFree.style.borderRadius = "10px";
        btnFree.style.border = "1px solid #ccc";
        btnFree.style.cursor = "pointer";
        r2.appendChild(btnFree);

        btnSave.onclick = async () => {
          try {
            await dmSetSlotLabel(s.slot, nameInp.value.trim() || `J${s.slot}`);
            await dmSetSlotColor(s.slot, colorInp.value);
          } catch (e) {
            alertError(e);
          }
        };

        btnFree.onclick = async () => {
          try {
            await dmAssignSlot(s.slot, null);
          } catch (e) {
            alertError(e);
          }
        };

        ui.dmAssignList.appendChild(box);
      }
    }
  }

  function normalizeHexColor(c) {
    if (!c) return null;
    const s = String(c).trim();
    // allow "#rrggbb"
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    return null;
  }

  // ====== TICK LOOP ======
  function startTick() {
    setInterval(() => {
      // re-render time every 250ms when running/combat, else every 1s is enough
      // we keep it simple: always queue render; RAF throttles.
      queueRender();
    }, 250);
  }

  // ====== BOOT ======
  (async () => {
    try {
      await ensureSession();
      buildUI();

      await loadRoom();
      await loadSlots();

      // If slots not present, create MIN_SLOTS by default (up to MAX if you prefer)
      if (slots.length < MIN_SLOTS) {
        const inserts = [];
        for (let i = slots.length + 1; i <= MIN_SLOTS; i++) {
          inserts.push({
            room_id: room.id,
            slot: i,
            color: DEFAULT_COLORS[i - 1] || "#777",
            label: `J${i}`,
            user_id: null,
            base_seconds: safeState().phase_default_seconds,
            spent_seconds: 0
          });
        }
        const { error } = await sb.from("player_slots").insert(inserts);
        if (error) throw error;
        await loadSlots();
      }

      // Join (auto-assign slot)
      await joinOrRestoreMySlot();

      // Reload to ensure my slot updated
      await loadSlots();

      // Subscribe realtime
      subscribeRealtime();

      // First render + tick
      queueRender();
      startTick();

    } catch (e) {
      fatal(
        "Indítási hiba:\n" +
        (e && e.message ? e.message : String(e)) +
        "\n\nMegjegyzés: ha RPC-ket használsz (start_or_switch_slot, begin_combat, dm_reset_phase, stb.), " +
        "ellenőrizd, hogy létre vannak-e hozva a Supabase-ben."
      );
      console.error(e);
    }
  })();
})();
