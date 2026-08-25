(function () {
  const CLINIC_DB_KEY = "gm_dental_db_v1";
  const SYNC_STAMP_KEY = "gm_dental_sync_stamp";
  const GLOBAL_SYNC_KEY = "gm_dental_global_sync";
  const LOCAL_CHANGE_STAMP_KEY = "gm_dental_local_change_stamp";
  const LAST_PUSHED_STAMP_KEY = "gm_dental_last_pushed_stamp";

  const API_BASE_URL =
    window.GM_DENTAL_API_BASE ||
    localStorage.getItem("gm_dental_api_base") ||
    (window.location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(window.location.hostname)
      ? "http://localhost:3000"
      : "");

  if (!API_BASE_URL && !window.location.origin) return;

  let isApplyingRemote = false;
  let pushTimer = 0;
  let pushInFlight = null;

  const originalSetItem = localStorage.setItem.bind(localStorage);

  function apiUrl(path) {
    return `${API_BASE_URL}${path}`;
  }

  function getLocalClinicDb() {
    try {
      return JSON.parse(localStorage.getItem(CLINIC_DB_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function hasClinicRows(db) {
    return [
      "patients",
      "dentists",
      "staff",
      "appointments",
      "dentistSchedules",
      "services",
      "payments",
      "archivedAppointments",
      "rescheduleRequests",
      "patientClinicalNotes",
      "treatmentPlans",
      "history",
      "notifications"
    ].some((key) => {
      const value = db?.[key];
      if (Array.isArray(value)) return value.length;
      if (key === "notifications" && value && typeof value === "object") {
        return Object.values(value).some((group) => Array.isArray(group) && group.length);
      }
      return false;
    });
  }

  function getLocalChangeStamp() {
    return Number(localStorage.getItem(LOCAL_CHANGE_STAMP_KEY) || 0);
  }

  function getLastPushedStamp() {
    return Number(localStorage.getItem(LAST_PUSHED_STAMP_KEY) || 0);
  }

  function markLocalDirty() {
    originalSetItem(LOCAL_CHANGE_STAMP_KEY, String(Date.now()));
  }

  function markLastPushed(stamp) {
    originalSetItem(LAST_PUSHED_STAMP_KEY, String(stamp));
  }

  function hasUnpushedChanges() {
    return getLocalChangeStamp() > getLastPushedStamp();
  }

  function notifyLocalPages() {
    const stamp = String(Date.now());
    originalSetItem(SYNC_STAMP_KEY, stamp);
    originalSetItem(GLOBAL_SYNC_KEY, stamp);

    try {
      window.dispatchEvent(new StorageEvent("storage", { key: CLINIC_DB_KEY }));
      window.dispatchEvent(new StorageEvent("storage", { key: SYNC_STAMP_KEY }));
      window.dispatchEvent(new StorageEvent("storage", { key: GLOBAL_SYNC_KEY }));
    } catch {
      window.dispatchEvent(new CustomEvent("gm-dental-supabase-sync"));
    }
  }

  function applyRemoteClinicDb(db) {
    if (!hasClinicRows(db)) return;
    isApplyingRemote = true;
    try {
      originalSetItem(CLINIC_DB_KEY, JSON.stringify(db));
      // Remote state matches what we just wrote; clear dirty so we don't push back.
      const stamp = Date.now();
      originalSetItem(LOCAL_CHANGE_STAMP_KEY, String(stamp));
      originalSetItem(LAST_PUSHED_STAMP_KEY, String(stamp));
      notifyLocalPages();
    } finally {
      isApplyingRemote = false;
    }
  }

  async function pullClinicDb() {
    // Never pull-and-overwrite when local has changes that haven't been pushed.
    // Push first so the local change reaches the server, then accept the
    // round-tripped state.
    if (hasUnpushedChanges()) {
      try {
        await pushClinicDb();
      } catch (error) {
        console.warn("Supabase push (before pull) failed:", error.message || error);
      }
      return;
    }

    try {
      const response = await fetch(apiUrl("/api/clinic-db"));
      if (!response.ok) return;

      const result = await response.json();
      const remoteDb = result.db || {};
      if (!hasClinicRows(remoteDb)) {
        const localDb = getLocalClinicDb();
        if (hasClinicRows(localDb)) schedulePush(250);
        return;
      }

      applyRemoteClinicDb(remoteDb);
    } catch (error) {
      console.warn("Supabase pull failed:", error.message || error);
    }
  }

  async function sendAppointmentReminders(db) {
    if (!hasClinicRows(db)) return;

    try {
      const response = await fetch(apiUrl("/api/appointment-reminders"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ db })
      });

      if (!response.ok) return;

      const result = await response.json();
      if (result.db && hasClinicRows(result.db)) {
        applyRemoteClinicDb(result.db);
      }
    } catch (error) {
      console.warn("Appointment reminder check failed:", error.message || error);
    }
  }

  async function pushClinicDb() {
    if (isApplyingRemote) return;

    // Coalesce concurrent push requests so a flushNow during an in-flight push
    // just awaits the same operation rather than racing.
    if (pushInFlight) return pushInFlight;

    pushInFlight = (async () => {
      const db = getLocalClinicDb();
      if (!hasClinicRows(db)) return;

      const stampAtSend = getLocalChangeStamp() || Date.now();

      try {
        await sendAppointmentReminders(db);

        const syncedDb = getLocalClinicDb();
        const response = await fetch(apiUrl("/api/clinic-db"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ db: syncedDb })
        });

        if (!response.ok) return;

        markLastPushed(stampAtSend);

        const result = await response.json();
        if (result.db && hasClinicRows(result.db)) {
          applyRemoteClinicDb(result.db);
        }
      } catch (error) {
        console.warn("Supabase push failed:", error.message || error);
      }
    })();

    try {
      await pushInFlight;
    } finally {
      pushInFlight = null;
    }
  }

  function schedulePush(delay = 250) {
    if (isApplyingRemote) return;
    window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(pushClinicDb, delay);
  }

  function flushNow() {
    window.clearTimeout(pushTimer);
    pushTimer = 0;
    return pushClinicDb();
  }

  // Fire-and-forget push on page unload so changes made just before refresh
  // still reach Supabase even if the debounced timer hasn't fired yet.
  function flushOnUnload() {
    if (!hasUnpushedChanges()) return;
    const db = getLocalClinicDb();
    if (!hasClinicRows(db)) return;

    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify({ db })], { type: "application/json" });
        // Server accepts POST /api/clinic-db with the same semantics as PUT.
        navigator.sendBeacon(apiUrl("/api/clinic-db"), blob);
        markLastPushed(getLocalChangeStamp() || Date.now());
      } else {
        fetch(apiUrl("/api/clinic-db"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ db }),
          keepalive: true
        }).catch(() => {});
      }
    } catch {
      /* best-effort only */
    }
  }

  localStorage.setItem = function patchedSetItem(key, value) {
    const result = originalSetItem(key, value);
    if (key === CLINIC_DB_KEY && !isApplyingRemote) {
      markLocalDirty();
      schedulePush();
    }
    return result;
  };

  window.addEventListener("storage", (event) => {
    if (event.key === CLINIC_DB_KEY && !isApplyingRemote) {
      // Another tab updated the DB; treat it as a local change so this tab
      // will push or persist it across reload.
      markLocalDirty();
      schedulePush();
    }
  });

  window.addEventListener("pagehide", flushOnUnload);
  window.addEventListener("beforeunload", flushOnUnload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnUnload();
  });

  window.GmDentalSupabaseSync = {
    pull: pullClinicDb,
    push: pushClinicDb,
    flushNow,
    apiBaseUrl: API_BASE_URL
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", pullClinicDb, { once: true });
  } else {
    pullClinicDb();
  }

  window.setInterval(pullClinicDb, 30000);
})();
