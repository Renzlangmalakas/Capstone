const SESSION_KEY = "gm_dental_current_user";
const STORAGE_KEY = "gm_dental_staff_page_v1";

function uid() {
  return Math.random().toString(36).slice(2, 11);
}

const defaultData = {
  theme: "dark",
  clinic: {
    name: "G-M Dental Clinic",
    phone: "09228724320",
    email: "ganalmappaladentalclinic@gmail.com",
    address: "Antipolo City, Philippines",
    openingTime: "09:00",
    closingTime: "18:00",
    workingDays: "Monday - Saturday"
  },
  staff: {
    name: "Front Desk Staff",
    email: "staff@email.com",
    role: "Receptionist",
    phone: "09123456789",
    profileImage: "https://ui-avatars.com/api/?name=Clinic+Staff&background=2563eb&color=fff"
  },
  patients: [
    { id: uid(), name: "Juan Dela Cruz", age: 30, gender: "Male", condition: "Consultation", contact: "09123456789", address: "Quezon City" },
    { id: uid(), name: "Maria Santos", age: 25, gender: "Female", condition: "Braces Adjustment", contact: "09987654321", address: "Manila" },
    { id: uid(), name: "Pedro Reyes", age: 10, gender: "Male", condition: "Routine Checkup", contact: "09112223333", address: "Quezon City" }
  ],
  appointments: [
    {
      id: uid(),
      patient: "Juan Dela Cruz",
      dentist: "Dr. Imelda G. Mappala",
      service: "Consultation",
      date: todayISO(),
      time: "09:00",
      status: "Waiting",
      paymentStatus: "Unpaid",
      total: 500,
      paid: 0,
      method: "-"
    },
    {
      id: uid(),
      patient: "Maria Santos",
      dentist: "Dr. Daniel Santos",
      service: "Orthodontic Adjustment",
      date: todayISO(),
      time: "10:30",
      status: "Confirmed",
      paymentStatus: "Partial",
      total: 1500,
      paid: 500,
      method: "GCash"
    },
    {
      id: uid(),
      patient: "Pedro Reyes",
      dentist: "Dr. Maria Reyes",
      service: "Oral Prophylaxis",
      date: nextDateISO(1),
      time: "13:00",
      status: "Confirmed",
      paymentStatus: "Paid",
      total: 1000,
      paid: 1000,
      method: "Cash"
    }
  ],
  inventory: [
    { id: uid(), item: "Gloves", category: "Consumables", stock: 180, reorderLevel: 50 },
    { id: uid(), item: "Face Masks", category: "Consumables", stock: 35, reorderLevel: 40 },
    { id: uid(), item: "Dental Cement", category: "Materials", stock: 12, reorderLevel: 8 },
    { id: uid(), item: "Cotton Rolls", category: "Consumables", stock: 25, reorderLevel: 30 }
  ],
  notifications: [
    { id: uid(), title: "New Walk-In", body: "A new walk-in patient was added to today’s queue.", time: "Just now", read: false, createdAt: new Date().toISOString() },
    { id: uid(), title: "Low Stock Alert", body: "Face Masks reached reorder level.", time: "5 mins ago", read: false, createdAt: new Date(Date.now() - 5 * 60000).toISOString() }
  ]
};

let state = loadState();
let currentSection = "home";

function getCurrentUser() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function ensureStaffSession() {
  const currentUser = getCurrentUser();
  if (!currentUser || currentUser.role !== "staff") {
    window.location.replace("../Landing/landing.html");
    return false;
  }

  if (currentUser.name) state.staff.name = currentUser.name;
  if (currentUser.email) state.staff.email = currentUser.email;
  if (currentUser.mobile) state.staff.phone = currentUser.mobile;
  if (currentUser.profileImage) state.staff.profileImage = currentUser.profileImage;
  state.staff.role = "Receptionist";
  return true;
}

const pageMeta = {
  home: { title: "Dashboard", subtitle: "Welcome back, Staff 👋" },
  queue: { title: "Patient Queue", subtitle: "Manage today’s queue and walk-ins." },
  appointments: { title: "Appointments", subtitle: "Track and update clinic appointments." },
  patients: { title: "Patients", subtitle: "Manage patient records and details." },
  account: { title: "Account", subtitle: "Update your staff account information." },
  settings: { title: "Settings", subtitle: "Configure clinic details and preferences." }
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  if (!ensureStaffSession()) return;

  withSyncSuspended(() => {
    pullFromClinicDb();
  });

  applyTheme();
  bindNavigation();
  bindTopbarMenus();
  bindSidebar();
  bindSettings();
  bindButtons();
  bindProfileUploadUI();
  fillForms();
  renderProfile();
  renderAll();

  bindClinicSyncListener();

  // Push current local state up so any clinic-side records that we created
  // before sync existed get reflected (idempotent).
  pushToClinicDb();
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultData);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(defaultData),
      ...parsed,
      clinic: { ...defaultData.clinic, ...(parsed.clinic || {}) },
      staff: { ...defaultData.staff, ...(parsed.staff || {}) },
      patients: Array.isArray(parsed.patients) ? parsed.patients : structuredClone(defaultData.patients),
      appointments: Array.isArray(parsed.appointments) ? parsed.appointments : structuredClone(defaultData.appointments),
      inventory: Array.isArray(parsed.inventory) ? parsed.inventory : structuredClone(defaultData.inventory),
      notifications: Array.isArray(parsed.notifications) ? parsed.notifications : structuredClone(defaultData.notifications)
    };
  } catch {
    return structuredClone(defaultData);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  pushToClinicDb();
}

/* =============================================================
   SHARED CLINIC DB SYNC
   The staff page reads patients/appointments/notifications from
   the same gm_dental_db_v1 store as admin/dentist/patient pages,
   and writes back so changes propagate everywhere.
============================================================= */

const CLINIC_DB_KEY = "gm_dental_db_v1";
const CLINIC_SYNC_STAMP_KEY = "gm_dental_sync_stamp";
let clinicSyncSuspended = false;

function getClinicDb() {
  try {
    const raw = localStorage.getItem(CLINIC_DB_KEY);
    if (!raw) {
      const initial = {
        patients: [],
        dentists: [],
        staff: [],
        appointments: [],
        archivedAppointments: [],
        rescheduleRequests: [],
        patientClinicalNotes: [],
        treatmentPlans: [],
        history: [],
        notifications: { admin: [], dentist: [], patient: [], staff: [] }
      };
      localStorage.setItem(CLINIC_DB_KEY, JSON.stringify(initial));
      return initial;
    }
    const parsed = JSON.parse(raw);
    return {
      patients: Array.isArray(parsed.patients) ? parsed.patients : [],
      dentists: Array.isArray(parsed.dentists) ? parsed.dentists : [],
      staff: Array.isArray(parsed.staff) ? parsed.staff : [],
      appointments: Array.isArray(parsed.appointments) ? parsed.appointments : [],
      archivedAppointments: Array.isArray(parsed.archivedAppointments) ? parsed.archivedAppointments : [],
      rescheduleRequests: Array.isArray(parsed.rescheduleRequests) ? parsed.rescheduleRequests : [],
      patientClinicalNotes: Array.isArray(parsed.patientClinicalNotes) ? parsed.patientClinicalNotes : [],
      treatmentPlans: Array.isArray(parsed.treatmentPlans) ? parsed.treatmentPlans : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      notifications: parsed.notifications || { admin: [], dentist: [], patient: [], staff: [] }
    };
  } catch {
    return {
      patients: [], dentists: [], staff: [], appointments: [],
      archivedAppointments: [], rescheduleRequests: [], patientClinicalNotes: [], treatmentPlans: [], history: [],
      notifications: { admin: [], dentist: [], patient: [], staff: [] }
    };
  }
}

function saveClinicDb(db) {
  localStorage.setItem(CLINIC_DB_KEY, JSON.stringify(db));
  localStorage.setItem(CLINIC_SYNC_STAMP_KEY, String(Date.now()));
}

/* ---------- field mappers between staff schema and clinic schema ---------- */

function clinicPatientToStaff(p) {
  return {
    id: p.id || uid(),
    name: p.name || "",
    age: p.age || "",
    gender: p.gender || "",
    condition: p.condition || "",
    address: p.address || "",
    contact: p.contact || p.mobile || "",
    email: p.email || "",
    archived: !!p.archived,
    createdAt: p.createdAt || p.updatedAt || "",
    updatedAt: p.updatedAt || ""
  };
}

function staffPatientToClinic(p, existing) {
  const now = new Date().toISOString();
  return {
    ...(existing || {}),
    id: p.id || existing?.id || uid(),
    name: p.name || "",
    age: p.age || "",
    gender: p.gender || "",
    condition: p.condition || "",
    address: p.address || "",
    contact: p.contact || "",
    email: p.email || existing?.email || "",
    archived: !!p.archived,
    createdAt: existing?.createdAt || p.createdAt || now,
    updatedAt: now
  };
}

function clinicAppointmentToStaff(a) {
  const total = Number(a.price ?? a.total ?? 0);
  const paid = Number(a.totalCollected ?? a.paid ?? 0);
  const remaining = Number(a.remainingBalance ?? Math.max(0, total - paid));
  const paymentStatus = a.paymentStatus
    || (paid <= 0 ? "Unpaid" : remaining <= 0 ? "Paid" : "Partial");

  return {
    id: a.id || uid(),
    patientId: a.patientId || "",
    patient: a.patient || a.patientName || "",
    patientName: a.patientName || a.patient || "",
    dentist: a.dentist || "",
    service: a.service || "",
    date: a.date || "",
    time: a.time || "",
    schedule: a.schedule || [a.date, a.time].filter(Boolean).join(" "),
    status: a.status || "Waiting",
    paymentStatus,
    total,
    paid,
    totalCollected: paid,
    remainingBalance: remaining,
    method: a.paymentMethod || a.method || "-",
    refunds: Array.isArray(a.refunds) ? a.refunds : [],
    refundMethodPending: a.refundMethodPending === true,
    preferredRefundMethod: a.preferredRefundMethod || "",
    refundGcashNumber: a.refundGcashNumber || "",
    archived: !!a.archived,
    archivedForDentist: a.archivedForDentist === true,
    archivedForPatient: a.archivedForPatient === true,
    createdAt: a.createdAt || "",
    updatedAt: a.updatedAt || ""
  };
}

function staffAppointmentToClinic(a, existing) {
  const total = Number(a.total || 0);
  const paid = Number(a.paid || 0);
  return {
    ...(existing || {}),
    id: a.id || existing?.id || uid(),
    patientId: a.patientId || existing?.patientId || "",
    patient: a.patient || "",
    patientName: a.patient || "",
    dentist: a.dentist || "",
    service: a.service || "",
    date: a.date || "",
    time: a.time || "",
    schedule: a.schedule || [a.date, a.time].filter(Boolean).join(" "),
    status: a.status || "Waiting",
    price: total,
    total,
    paid,
    totalCollected: paid,
    remainingBalance: Math.max(0, total - paid),
    paymentMethod: a.method && a.method !== "-" ? a.method : (existing?.paymentMethod || ""),
    paymentStatus: a.paymentStatus || existing?.paymentStatus || "Unpaid",
    refunds: Array.isArray(a.refunds) ? a.refunds : (Array.isArray(existing?.refunds) ? existing.refunds : []),
    refundMethodPending: a.refundMethodPending === true,
    preferredRefundMethod: a.preferredRefundMethod || existing?.preferredRefundMethod || "",
    refundGcashNumber: a.refundGcashNumber || existing?.refundGcashNumber || "",
    archived: !!(a.archived || existing?.archived),
    archivedForDentist: a.archivedForDentist === true || existing?.archivedForDentist === true,
    archivedForPatient: a.archivedForPatient === true || existing?.archivedForPatient === true,
    updatedAt: new Date().toISOString()
  };
}

/* ---------- profile enrichment ---------- */

function pullStaffProfileFromClinicDb(db) {
  const me = getCurrentUser();
  if (!me || !Array.isArray(db.staff) || !db.staff.length) return;

  const meEmail = String(me.email || "").trim().toLowerCase();
  const meName = String(me.name || "").trim().toLowerCase();

  const match = db.staff.find(s => {
    if (s.archived) return false;
    const sEmail = String(s.email || "").trim().toLowerCase();
    const sName = String(s.name || "").trim().toLowerCase();
    return (meEmail && sEmail === meEmail) || (meName && sName === meName);
  });

  if (!match) return;

  if (match.name) state.staff.name = match.name;
  if (match.email) state.staff.email = match.email;
  if (match.contact) state.staff.phone = match.contact;
  if (match.position) state.staff.role = match.position;
}

/* ---------- core pull / push ---------- */

function pullFromClinicDb() {
  const db = getClinicDb();

  pullStaffProfileFromClinicDb(db);

  const localApptById = new Map((state.appointments || []).map(a => [a.id, a]));
  state.appointments = (db.appointments || [])
    .filter(a => !a.archived)
    .map(a => {
      const mapped = clinicAppointmentToStaff(a);
      const local = localApptById.get(mapped.id);
      if (local) {
        mapped.method = local.method && local.method !== "-" ? local.method : mapped.method;
      }
      return mapped;
    });

  const localPatientById = new Map((state.patients || []).map(p => [p.id, p]));
  state.patients = (db.patients || [])
    .filter(p => !p.archived)
    .map(p => {
      const mapped = clinicPatientToStaff(p);
      const local = localPatientById.get(mapped.id);
      if (local) {
        mapped.condition = mapped.condition || local.condition || "";
        mapped.address = mapped.address || local.address || "";
      }
      return mapped;
    });
}

function pushToClinicDb() {
  if (clinicSyncSuspended) return;

  const db = getClinicDb();

  const dbApptById = new Map((db.appointments || []).map(a => [a.id, a]));
  const localIds = new Set((state.appointments || []).map(a => a.id));
  const merged = (state.appointments || []).map(a =>
    staffAppointmentToClinic(a, dbApptById.get(a.id))
  );
  // keep clinic-only appointments (e.g. archived ones, or ones from dentist/patient
  // that we filtered out on pull)
  (db.appointments || []).forEach(a => {
    if (!localIds.has(a.id)) merged.push(a);
  });
  db.appointments = merged;

  const dbPatientById = new Map((db.patients || []).map(p => [p.id, p]));
  const localPatientIds = new Set((state.patients || []).map(p => p.id));
  const mergedPatients = (state.patients || []).map(p =>
    staffPatientToClinic(p, dbPatientById.get(p.id))
  );
  (db.patients || []).forEach(p => {
    if (!localPatientIds.has(p.id)) mergedPatients.push(p);
  });
  db.patients = mergedPatients;

  saveClinicDb(db);
}

function withSyncSuspended(fn) {
  clinicSyncSuspended = true;
  try {
    fn();
  } finally {
    clinicSyncSuspended = false;
  }
}

function bindClinicSyncListener() {
  window.addEventListener("storage", (event) => {
    if (event.key !== CLINIC_DB_KEY && event.key !== CLINIC_SYNC_STAMP_KEY) return;
    withSyncSuspended(() => {
      pullFromClinicDb();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    });
    renderAll();
  });
}

function qs(selector, root = document) {
  return root.querySelector(selector);
}

function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

// UI helpers + defensive guards
function byId(id) {
  return document.getElementById(id);
}

function safeOn(target, eventName, handler, options) {
  if (!target || typeof target.addEventListener !== "function") return null;
  target.addEventListener(eventName, handler, options);
  return target;
}

function safeValue(element, fallback = "") {
  return element ? String(element.value ?? fallback) : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizedStatus(status, fallback = "Waiting") {
  const raw = String(status ?? "").trim();
  if (!raw) return fallback;

  const key = raw.toLowerCase();
  const aliasMap = {
    pending: "Waiting",
    approved: "Confirmed",
    rejected: "Rejected"
  };

  return aliasMap[key] || raw;
}

function statusClassName(status) {
  return normalizedStatus(status).toLowerCase().replace(/\s+/g, "-");
}

function isClosedStaffStatus(status) {
  return ["completed", "cancelled", "rejected"].includes(statusClassName(status));
}

function tableEmptyRow(colspan, title, text, icon = "bi-inbox") {
  return `
    <tr>
      <td colspan="${colspan}">
        <div class="empty-state rich-empty">
          <i class="bi ${icon}"></i>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(text)}</span>
        </div>
      </td>
    </tr>
  `;
}

function bindNavigation() {
  qsa(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => showSection(btn.dataset.section));
  });

  qsa("[data-section-jump]").forEach(btn => {
    btn.addEventListener("click", () => {
      closeFloatingMenus();
      showSection(btn.dataset.sectionJump);
    });
  });
}

function showSection(sectionId) {
  currentSection = sectionId;

  qsa(".section").forEach(section => section.classList.remove("active"));
  qsa(".nav-item").forEach(btn => btn.classList.remove("active"));

  const targetSection = qs(`#${sectionId}`);
  const targetNav = qs(`.nav-item[data-section="${sectionId}"]`);

  if (targetSection) targetSection.classList.add("active");
  if (targetNav) targetNav.classList.add("active");

  const meta = pageMeta[sectionId];
  if (meta) {
    qs("#pageTitle").textContent = meta.title;
    qs("#pageSubtitle").textContent = meta.subtitle;
  }

  closeFloatingMenus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindTopbarMenus() {
  const notifToggle = qs("#notifToggle");
  const notifPanel = qs("#notifPanel");
  const profileToggle = qs("#profileToggle");
  const profilePanel = qs("#profilePanel");

  if (!notifToggle || !notifPanel || !profileToggle || !profilePanel) return;

  function hidePanels() {
    notifPanel.classList.remove("show");
    profilePanel.classList.remove("show");
  }

  safeOn(notifToggle, "click", (e) => {
    e.stopPropagation();
    const open = notifPanel.classList.contains("show");
    hidePanels();

    if (!open) {
      notifPanel.classList.add("show");
      state.notifications = (state.notifications || []).map(n => ({ ...n, read: true }));
      saveState();
      renderNotifications();
    }
  });

  safeOn(profileToggle, "click", (e) => {
    e.stopPropagation();
    const open = profilePanel.classList.contains("show");
    hidePanels();
    if (!open) profilePanel.classList.add("show");
  });

  safeOn(notifPanel, "click", (e) => e.stopPropagation());
  safeOn(profilePanel, "click", (e) => e.stopPropagation());
  safeOn(document, "click", hidePanels);
  safeOn(window, "resize", hidePanels);

  safeOn(qs("#logoutBtn"), "click", () => {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem("gm_dental_session_lock");
    showToast("Logged out successfully.", "info");
    setTimeout(() => {
      window.location.href = "../Landing/landing.html";
    }, 700);
  });
}

function bindSidebar() {
  safeOn(qs("#sidebarToggle"), "click", () => {
    qs("#sidebar")?.classList.toggle("collapsed");
    closeFloatingMenus();
  });
}

function bindSettings() {
  safeOn(qs("#themeToggle"), "click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    saveState();
    applyTheme();
  });

  safeOn(qs("#saveClinicBtn"), "click", saveClinicInfo);
  safeOn(qs("#saveScheduleBtn"), "click", saveClinicSchedule);
  safeOn(qs("#saveStaffBtn"), "click", saveStaffAccount);
  safeOn(qs("#saveProfileImageBtn"), "click", saveStaffProfileImage);
}

function bindButtons() {
  safeOn(qs("#addWalkInBtn"), "click", openWalkInModal);
  safeOn(qs("#addAppointmentBtn"), "click", openAppointmentModal);
  safeOn(qs("#addPaymentBtn"), "click", openPaymentModal);
  safeOn(qs("#addPatientBtn"), "click", openPatientModal);

  safeOn(qs("#patientSearch"), "input", renderPatients);
  safeOn(qs("#patientSort"), "change", renderPatients);
  safeOn(qs("#appointmentSearch"), "input", renderAppointments);
  safeOn(qs("#appointmentFilter"), "change", renderAppointments);
  safeOn(qs("#appointmentDateFilter"), "change", () => {
    syncStaffDateFilterInput();
    renderAppointments();
  });
  safeOn(qs("#appointmentDateSpecific"), "change", renderAppointments);
  safeOn(qs("#reportExportType"), "change", renderPatients);
  safeOn(qs("#reportDateFilter"), "change", () => {
    syncStaffReportDateFilterInput();
    renderPatients();
  });
  safeOn(qs("#reportDateSpecific"), "change", renderPatients);
  safeOn(qs("#exportPatientRecordsBtn"), "click", exportPatientRecordsCsv);
  safeOn(qs("#revenueDateFilter"), "change", () => {
    syncStaffRevenueDateFilterInput();
    renderRevenue();
  });
  safeOn(qs("#revenueDateSpecific"), "change", renderRevenue);

  safeOn(qs("#closeModalBtn"), "click", closeSharedModal);
  safeOn(qs("#modalBackdrop"), "click", (e) => {
    if (e.target?.id === "modalBackdrop") closeSharedModal();
  });

  safeOn(qs("#closeViewBtn"), "click", closeViewModal);
  safeOn(qs("#viewBackdrop"), "click", (e) => {
    if (e.target?.id === "viewBackdrop") closeViewModal();
  });
}

function applyTheme() {
  document.body.classList.toggle("dark", state.theme === "dark");
}

function fillForms() {
  const setIfPresent = (selector, value) => {
    const el = qs(selector);
    if (el) el.value = value ?? "";
  };

  setIfPresent("#clinicName", state.clinic.name);
  setIfPresent("#clinicPhone", state.clinic.phone);
  setIfPresent("#clinicEmail", state.clinic.email);
  setIfPresent("#clinicAddress", state.clinic.address);
  setIfPresent("#openingTime", state.clinic.openingTime);
  setIfPresent("#closingTime", state.clinic.closingTime);
  setIfPresent("#workingDays", state.clinic.workingDays);

  setIfPresent("#staffName", state.staff.name);
  setIfPresent("#staffEmail", state.staff.email);
  setIfPresent("#staffRole", state.staff.role);
  setIfPresent("#staffPhone", state.staff.phone);
}

function renderProfile() {
  const img = qs("#topbarProfileImage");
  const nameEl = qs("#topbarStaffName");
  const previewImg = qs("#settingsProfilePreview");
  const defaultAvatar = "https://ui-avatars.com/api/?name=Clinic+Staff&background=2563eb&color=fff";

  if (img) img.src = state.staff.profileImage || defaultAvatar;
  if (previewImg) previewImg.src = state.staff.profileImage || defaultAvatar;
  if (nameEl) nameEl.textContent = state.staff.name || "Front Desk Staff";
}

function saveClinicInfo() {
  state.clinic.name = qs("#clinicName").value.trim();
  state.clinic.phone = qs("#clinicPhone").value.trim();
  state.clinic.email = qs("#clinicEmail").value.trim();
  state.clinic.address = qs("#clinicAddress").value.trim();
  saveState();
  addNotification("Clinic Updated", "Clinic information was updated.");
  showToast("Clinic information saved.", "success");
}

function saveClinicSchedule() {
  state.clinic.openingTime = qs("#openingTime").value;
  state.clinic.closingTime = qs("#closingTime").value;
  state.clinic.workingDays = qs("#workingDays").value;
  saveState();
  addNotification("Schedule Updated", "Clinic schedule was updated.");
  showToast("Clinic schedule saved.", "success");
}

function bindProfileUploadUI() {
  const input = qs("#staffProfileImage");
  const trigger = qs("#profileUploadTrigger");
  const nameEl = qs("#profileUploadName");
  const box = qs("#profileUploadBox");

  if (!input || !trigger || !nameEl || !box) return;

  trigger.addEventListener("click", () => input.click());

  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (file) {
      nameEl.textContent = file.name;
      box.classList.add("is-active");
    } else {
      nameEl.textContent = "No file selected";
      box.classList.remove("is-active");
    }
  });
}

function saveStaffAccount() {
  const name = qs("#staffName").value.trim();
  const email = qs("#staffEmail").value.trim();
  const role = qs("#staffRole").value.trim();
  const phone = qs("#staffPhone").value.trim();
  const password = qs("#staffPassword").value;
  const confirm = qs("#staffConfirmPassword").value;

  if (!name || !email || !role || !phone) {
    showToast("Please fill all staff account fields.", "error");
    return;
  }

  if (password || confirm) {
    if (password !== confirm) {
      showToast("Passwords do not match.", "error");
      return;
    }
  }

  state.staff.name = name;
  state.staff.email = email;
  state.staff.role = role;
  state.staff.phone = phone;

  saveState();
  renderProfile();

  qs("#staffPassword").value = "";
  qs("#staffConfirmPassword").value = "";

  addNotification("Account Updated", `${name} updated the staff account.`);
  showToast("Staff account updated.", "success");
}

function saveStaffProfileImage() {
  const fileInput = qs("#staffProfileImage");
  const uploadName = qs("#profileUploadName");
  const uploadBox = qs("#profileUploadBox");
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;

  if (!file) {
    showToast("Choose an image first.", "error");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    state.staff.profileImage = e.target.result;
    saveState();
    renderProfile();

    if (fileInput) fileInput.value = "";
    if (uploadName) uploadName.textContent = "No file selected";
    if (uploadBox) uploadBox.classList.remove("is-active");

    addNotification("Profile Picture Updated", `${state.staff.name || "Staff"} changed the profile picture.`);
    showToast("Profile picture updated.", "success");
  };
  reader.readAsDataURL(file);
}

function renderAll() {
  renderNotifications();
  renderDashboard();
  renderQueue();
  renderAppointments();
  renderBilling();
  renderRevenue();
  renderPatients();
  fillForms();
  renderProfile();
}

function addNotification(title, body) {
  state.notifications.unshift({
    id: uid(),
    title,
    body,
    time: "Just now",
    read: false,
    createdAt: new Date().toISOString()
  });
  state.notifications = state.notifications.slice(0, 20);
  saveState();
  renderNotifications();
}

function renderNotifications() {
  const list = qs("#notifList");
  const dot = qs("#notifDot");
  let hasUnread = false;

  list.innerHTML = "";

  state.notifications.forEach(item => {
    if (item.read === false) hasUnread = true;

    const div = document.createElement("div");
    div.className = "notification-item";
    div.innerHTML = `
      <strong>${escapeHtml(item.title)}</strong>
      <p>${escapeHtml(item.body)}</p>
      <span>${escapeHtml(item.time)}</span>
    `;
    list.appendChild(div);
  });

  dot.classList.toggle("hidden", !hasUnread);

  qs("#seeAllNotificationsBtn").onclick = () => {
    closeFloatingMenus();
    openViewModal(
      "All Notifications",
      state.notifications.length
        ? state.notifications.map(item => `
          <div class="detail-box">
            <strong>${escapeHtml(item.title)}</strong>
            <div>${escapeHtml(item.body)}</div>
            <div style="margin-top:6px;color:var(--muted);">${escapeHtml(item.time)}</div>
          </div>
        `).join("")
        : `<div class="empty-state">No notifications available.</div>`
    );
  };
}

function renderDashboard() {
  const today = todayISO();
  const todaysAppointments = state.appointments.filter(a => a.date === today);
  const waitingPatients = todaysAppointments.filter(a => a.status === "Waiting").length;
  const collectedToday = todaysAppointments.reduce((sum, a) => sum + Number(a.paid || 0), 0);

  qs("#statToday").textContent = String(todaysAppointments.length);
  qs("#statWaiting").textContent = String(waitingPatients);
  qs("#statCollected").textContent = formatMoney(collectedToday);

  const recentBody = qs("#dashboardRecentAppointments");
  recentBody.innerHTML = "";

  const recent = [...state.appointments]
    .sort((a, b) => dateTimeValue(b.date, b.time) - dateTimeValue(a.date, a.time))
    .slice(0, 12);

  if (!recent.length) {
    recentBody.innerHTML = `<tr><td colspan="5" class="empty-state">No activity yet.</td></tr>`;
  } else {
    recent.forEach(item => {
      recentBody.insertAdjacentHTML("beforeend", `
        <tr>
          <td>${escapeHtml(item.patient)}</td>
          <td>${escapeHtml(item.service)}</td>
          <td>${escapeHtml(item.dentist)}</td>
          <td>${formatTime(item.time)}</td>
          <td>${statusBadge(item.status)}</td>
        </tr>
      `);
    });
  }

  const queueBox = qs("#queueOverview");
  queueBox.innerHTML = "";

  const queueItems = todaysAppointments
    .filter(a => ["Waiting", "Confirmed", "In Progress"].includes(a.status))
    .sort((a, b) => a.time.localeCompare(b.time));

  if (!queueItems.length) {
    queueBox.innerHTML = `<div class="empty-state">No queue items today.</div>`;
  } else {
    queueItems.forEach((a, index) => {
      queueBox.insertAdjacentHTML("beforeend", `
        <div class="list-item">
          <strong>#${index + 1} • ${escapeHtml(a.patient)}</strong>
          <span>${escapeHtml(a.service)} with ${escapeHtml(a.dentist)} • ${formatTime(a.time)}</span>
        </div>
      `);
    });
  }

  const alerts = [];
  if (waitingPatients > 0) alerts.push({ title: `${waitingPatients} waiting patients`, body: "Patients are currently waiting to be served." });
  const unpaid = state.appointments.filter(a => a.paymentStatus !== "Paid").length;
  alerts.push({ title: `${unpaid} unpaid or partial payments`, body: "Billing follow-up may be needed." });

  const alertsBox = qs("#alertsBox");
  alertsBox.innerHTML = alerts.map(item => `
    <div class="list-item">
      <strong>${escapeHtml(item.title)}</strong>
      <p>${escapeHtml(item.body)}</p>
    </div>
  `).join("");

  qs("#seeMoreQueueBtn").onclick = () => {
    openViewModal(
      "Queue Overview",
      queueItems.length
        ? queueItems.map((a, index) => `
          <div class="detail-box">
            <strong>#${index + 1} • ${escapeHtml(a.patient)}</strong>
            <div>${escapeHtml(a.service)}</div>
            <div>${escapeHtml(a.dentist)} • ${formatTime(a.time)}</div>
            <div>${statusBadge(a.status)}</div>
          </div>
        `).join("")
        : `<div class="empty-state">No queue items today.</div>`
    );
  };

  qs("#seeMoreAlertsBtn").onclick = () => {
    openViewModal(
      "All Alerts",
      alerts.length
        ? alerts.map(item => `
          <div class="detail-box">
            <strong>${escapeHtml(item.title)}</strong>
            <div>${escapeHtml(item.body)}</div>
          </div>
        `).join("")
        : `<div class="empty-state">No alerts available.</div>`
    );
  };
}

function renderQueue() {
  const tbody = qs("#queueTable");
  tbody.innerHTML = "";

  const items = state.appointments
    .filter(a => a.date === todayISO())
    .sort((a, b) => a.time.localeCompare(b.time));

  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No queue items found.</td></tr>`;
    return;
  }

  items.forEach((item, index) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.patient)}</td>
      <td>${escapeHtml(item.service)}</td>
      <td>${escapeHtml(item.dentist)}</td>
      <td>${formatTime(item.time)}</td>
      <td>#${index + 1}</td>
      <td>${statusBadge(item.status)}</td>
      <td class="action-menu-cell">
        <button class="kebab-btn" type="button">
          <i class="bi bi-three-dots-vertical"></i>
        </button>
        <div class="dropdown">
          <button type="button" data-action="confirm">Mark Confirmed</button>
          <button type="button" data-action="progress">Start Service</button>
          <button type="button" data-action="complete">Mark Completed</button>
          <button type="button" class="danger-text" data-action="cancel">Cancel</button>
        </div>
      </td>
    `;

    const kebab = tr.querySelector(".kebab-btn");
    const menu = tr.querySelector(".dropdown");

    kebab.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDropdown(menu, kebab);
    });

    menu.querySelector('[data-action="confirm"]').addEventListener("click", () => updateAppointmentStatus(item.id, "Confirmed"));
    menu.querySelector('[data-action="progress"]').addEventListener("click", () => updateAppointmentStatus(item.id, "In Progress"));
    menu.querySelector('[data-action="complete"]').addEventListener("click", () => updateAppointmentStatus(item.id, "Completed"));
    menu.querySelector('[data-action="cancel"]').addEventListener("click", () => updateAppointmentStatus(item.id, "Cancelled"));

    tbody.appendChild(tr);
  });
}

function renderAppointments() {
  const tbody = qs("#appointmentsTable");
  tbody.innerHTML = "";

  const search = qs("#appointmentSearch").value.trim().toLowerCase();
  const filter = qs("#appointmentFilter").value;

  let items = [...state.appointments];

  if (search) {
    items = items.filter(a =>
      a.patient.toLowerCase().includes(search) ||
      a.service.toLowerCase().includes(search) ||
      a.dentist.toLowerCase().includes(search)
    );
  }

  if (filter) {
    items = items.filter(a => a.status === filter);
  }

  items.sort((a, b) => dateTimeValue(a.date, a.time) - dateTimeValue(b.date, b.time));

  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No appointments found.</td></tr>`;
    return;
  }

  items.forEach(item => {
    const tr = document.createElement("tr");
    tr.className = `appointment-table-row${item.date === todayISO() ? " is-today" : ""}`;
    tr.innerHTML = `
      <td>
        <div class="table-identity">
          <strong>${escapeHtml(item.patient)}</strong>
          <span>${item.date === todayISO() ? "Today" : "Patient Record"}</span>
        </div>
      </td>
      <td>
        <div class="table-identity">
          <strong>${escapeHtml(item.dentist)}</strong>
          <span>Dentist</span>
        </div>
      </td>
      <td>
        <div class="table-service">
          <span class="service-mark"><i class="bi bi-shield-plus"></i></span>
          <span>${escapeHtml(item.service)}</span>
        </div>
      </td>
      <td><span class="table-muted">${formatDate(item.date)}</span></td>
      <td><span class="table-muted">${formatTime(item.time)}</span></td>
      <td>${statusBadge(item.status)}</td>
      <td class="action-menu-cell">
        <button class="kebab-btn" type="button">
          <i class="bi bi-three-dots-vertical"></i>
        </button>
        <div class="dropdown">
          <button type="button" data-action="edit">Edit</button>
          <button type="button" data-action="payment">Record Payment</button>
          <button type="button" data-action="view">View</button>
          <button type="button" class="danger-text" data-action="cancel">Cancel</button>
        </div>
      </td>
    `;

    const kebab = tr.querySelector(".kebab-btn");
    const menu = tr.querySelector(".dropdown");

    kebab.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDropdown(menu, kebab);
    });

    menu.querySelector('[data-action="edit"]').addEventListener("click", () => openAppointmentModal(item.id));
    menu.querySelector('[data-action="payment"]').addEventListener("click", () => openPaymentModal(item.id));
    menu.querySelector('[data-action="view"]').addEventListener("click", () => showAppointmentView(item.id));
    menu.querySelector('[data-action="cancel"]').addEventListener("click", () => updateAppointmentStatus(item.id, "Cancelled"));

    tbody.appendChild(tr);
  });
}

function renderBilling() {
  const tbody = qs("#billingTable");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!state.appointments.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No billing records found.</td></tr>`;
    return;
  }

  state.appointments.forEach(item => {
    const balance = Math.max(0, Number(item.total || 0) - Number(item.paid || 0));
    const totalRefunded = getTotalRefunded(item);
    const refundable = isRefundableAppointment(item);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.patient)}</td>
      <td>${escapeHtml(item.service)}</td>
      <td>${formatMoney(item.total)}</td>
      <td>${formatMoney(item.paid)}</td>
      <td>
        ${formatMoney(totalRefunded)}
        ${item.refundMethodPending === true ? `<div class="table-cell-muted">Awaiting choice</div>` : ""}
      </td>
      <td>${formatMoney(balance)}</td>
      <td>${escapeHtml(item.method || "-")}</td>
      <td>${paymentBadge(item.paymentStatus)}</td>
      <td>
        <div class="inline-actions">
          <button class="action-btn edit" type="button" title="Record Payment">
            <i class="bi bi-cash-coin"></i>
          </button>
          ${refundable ? `
            <button class="action-btn refund" type="button" title="Process Refund">
              <i class="bi bi-arrow-counterclockwise"></i>
            </button>
          ` : ""}
          <button class="action-btn success" type="button" title="View">
            <i class="bi bi-eye"></i>
          </button>
        </div>
      </td>
    `;

    tr.querySelector(".edit").addEventListener("click", () => openPaymentModal(item.id));
    tr.querySelector(".refund")?.addEventListener("click", () => openRefundModal(item.id));
    tr.querySelector(".success").addEventListener("click", () => showAppointmentView(item.id));

    tbody.appendChild(tr);
  });
}

function formatCreatedDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function renderPatients() {
  const tbody = qs("#patientsTable");
  if (!tbody) return;
  tbody.innerHTML = "";

  const table = tbody.closest("table");
  const headerRow = table?.querySelector("thead tr");
  if (headerRow) {
    headerRow.innerHTML = `
      <th>Name</th>
      <th>Email</th>
      <th>Phone</th>
      <th>Status</th>
      <th>Created Date</th>
      <th>Actions</th>
    `;
  }

  if (renderStaffReportPreviewIfNeeded()) return;

  const search = qs("#patientSearch").value.trim().toLowerCase();
  const sort = qs("#patientSort").value;

  let items = [...state.patients];

  if (search) {
    items = items.filter(p =>
      safeText(p.name, "").toLowerCase().includes(search) ||
      safeText(p.email, "").toLowerCase().includes(search) ||
      safeText(p.condition, "").toLowerCase().includes(search)
    );
  }

  if (sort === "name") {
    items.sort((a, b) => safeText(a.name).localeCompare(safeText(b.name)));
  } else if (sort === "age") {
    items.sort((a, b) => Number(a.age || 0) - Number(b.age || 0));
  }

  if (!items.length) {
    tbody.innerHTML = tableEmptyRow(6, "No patients found", "Matching patient records will appear here.", "bi-people");
    return;
  }

  items.forEach(patient => {
    const status = patient.archived ? "Archived" : "Active";
    const created = formatCreatedDate(patient.createdAt || patient.updatedAt);

    const tr = document.createElement("tr");
    tr.className = "appointment-table-row entity-table-row";
    tr.innerHTML = `
      <td>
        <div class="table-identity">
          <strong>${escapeHtml(safeText(patient.name, "Unnamed Patient"))}</strong>
          <span>${escapeHtml(safeText(patient.condition, "Patient record"))}</span>
        </div>
      </td>
      <td><span class="table-cell-muted">${escapeHtml(safeText(patient.email, "-"))}</span></td>
      <td><span class="table-cell-muted">${escapeHtml(safeText(patient.contact, "-"))}</span></td>
      <td>${statusBadge(status)}</td>
      <td><span class="table-muted">${escapeHtml(created)}</span></td>
      <td class="action-menu-cell">
        <button class="kebab-btn" type="button" aria-label="Open patient actions">
          <i class="bi bi-three-dots-vertical"></i>
        </button>
        <div class="dropdown">
          <button type="button" data-action="view"><i class="bi bi-eye"></i> View</button>
          <button type="button" data-action="edit"><i class="bi bi-pencil-square"></i> Edit</button>
          <button type="button" class="danger-text" data-action="delete"><i class="bi bi-trash"></i> Delete</button>
        </div>
      </td>
    `;

    const kebab = tr.querySelector(".kebab-btn");
    const menu = tr.querySelector(".dropdown");

    kebab.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDropdown(menu, kebab);
    });

    menu.querySelector('[data-action="view"]').addEventListener("click", () => showPatientView(patient.id));
    menu.querySelector('[data-action="edit"]').addEventListener("click", () => openPatientModal(patient.id));
    menu.querySelector('[data-action="delete"]').addEventListener("click", () => deletePatient(patient.id));

    tbody.appendChild(tr);
  });
}

function openWalkInModal() {
  const today = todayISO();

  openSharedModal("Add Walk-In Patient", `
    <div class="form-grid one">
      <div>
        <label class="label" for="walkInPatient">Patient Name</label>
        <input class="input" id="walkInPatient" type="text" placeholder="Enter patient name" />
      </div>
      <div>
        <label class="label" for="walkInService">Service</label>
        <input class="input" id="walkInService" type="text" placeholder="Enter service" />
      </div>
      <div>
        <label class="label" for="walkInDentist">Dentist</label>
        <input class="input" id="walkInDentist" type="text" placeholder="Enter dentist name" />
      </div>
      <div>
        <label class="label" for="walkInTime">Time</label>
        <input class="input" id="walkInTime" type="time" value="09:00" />
      </div>
      <div class="form-actions-inline">
        <button class="btn primary" type="button" id="saveWalkInBtn">Save Walk-In</button>
      </div>
    </div>
  `);

  qs("#saveWalkInBtn").addEventListener("click", () => {
    const patient = qs("#walkInPatient").value.trim();
    const service = qs("#walkInService").value.trim();
    const dentist = qs("#walkInDentist").value.trim();
    const time = qs("#walkInTime").value;

    if (!patient || !service || !dentist || !time) {
      showToast("Please fill all walk-in fields.", "error");
      return;
    }

    state.appointments.push({
      id: uid(),
      patient,
      dentist,
      service,
      date: today,
      time,
      status: "Waiting",
      paymentStatus: "Unpaid",
      total: 500,
      paid: 0,
      method: "-"
    });

    saveState();
    closeSharedModal();
    addNotification("Walk-In Added", `${patient} was added to the queue.`);
    showToast("Walk-in patient added.", "success");
    renderAll();
  });
}

function openAppointmentModal(id = null) {
  const item = id ? state.appointments.find(x => x.id === id) : null;

  openSharedModal(item ? "Edit Appointment" : "Add Appointment", `
    <div class="form-grid one">
      <div>
        <label class="label" for="appointmentPatient">Patient</label>
        <input class="input" id="appointmentPatient" type="text" value="${escapeAttr(item?.patient || "")}" />
      </div>
      <div>
        <label class="label" for="appointmentDentist">Dentist</label>
        <input class="input" id="appointmentDentist" type="text" value="${escapeAttr(item?.dentist || "")}" />
      </div>
      <div>
        <label class="label" for="appointmentService">Service</label>
        <input class="input" id="appointmentService" type="text" value="${escapeAttr(item?.service || "")}" />
      </div>
      <div class="form-grid two">
        <div>
          <label class="label" for="appointmentDate">Date</label>
          <input class="input" id="appointmentDate" type="date" value="${escapeAttr(item?.date || todayISO())}" />
        </div>
        <div>
          <label class="label" for="appointmentTime">Time</label>
          <input class="input" id="appointmentTime" type="time" value="${escapeAttr(item?.time || "09:00")}" />
        </div>
      </div>
      <div>
        <label class="label" for="appointmentStatus">Status</label>
        <select class="input select" id="appointmentStatus">
          <option ${item?.status === "Waiting" ? "selected" : ""}>Waiting</option>
          <option ${item?.status === "Confirmed" ? "selected" : ""}>Confirmed</option>
          <option ${item?.status === "In Progress" ? "selected" : ""}>In Progress</option>
          <option ${item?.status === "Completed" ? "selected" : ""}>Completed</option>
          <option ${item?.status === "Cancelled" ? "selected" : ""}>Cancelled</option>
        </select>
      </div>
      <div>
        <label class="label" for="appointmentTotal">Total Fee</label>
        <input class="input" id="appointmentTotal" type="number" min="0" value="${escapeAttr(String(item?.total ?? 500))}" />
      </div>
      <div class="form-actions-inline">
        <button class="btn primary" type="button" id="saveAppointmentBtn">${item ? "Update" : "Save"} Appointment</button>
      </div>
    </div>
  `);

  qs("#saveAppointmentBtn").addEventListener("click", () => {
    const patient = qs("#appointmentPatient").value.trim();
    const dentist = qs("#appointmentDentist").value.trim();
    const service = qs("#appointmentService").value.trim();
    const date = qs("#appointmentDate").value;
    const time = qs("#appointmentTime").value;
    const status = qs("#appointmentStatus").value;
    const total = Number(qs("#appointmentTotal").value || 0);

    if (!patient || !dentist || !service || !date || !time) {
      showToast("Please fill all appointment fields.", "error");
      return;
    }

    if (item) {
      Object.assign(item, { patient, dentist, service, date, time, status, total });
    } else {
      state.appointments.push({
        id: uid(),
        patient,
        dentist,
        service,
        date,
        time,
        status,
        paymentStatus: "Unpaid",
        total,
        paid: 0,
        method: "-"
      });
    }

    saveState();
    closeSharedModal();
    addNotification(item ? "Appointment Updated" : "Appointment Added", `${patient} appointment was saved.`);
    showToast(item ? "Appointment updated." : "Appointment added.", "success");
    renderAll();
  });
}

function openPaymentModal(id = null) {
  const item = id ? state.appointments.find(x => x.id === id) : state.appointments[0];
  if (!item) {
    showToast("No appointment available for payment.", "error");
    return;
  }

  const balance = Math.max(0, Number(item.total || 0) - Number(item.paid || 0));

  openSharedModal("Record Payment", `
    <div class="form-grid one">
      <div class="detail-box">
        <strong>${escapeHtml(item.patient)}</strong>
        <div>${escapeHtml(item.service)} • ${escapeHtml(item.dentist)}</div>
        <div>${formatDate(item.date)} • ${formatTime(item.time)}</div>
      </div>
      <div class="form-grid two">
        <div>
          <label class="label">Total</label>
          <input class="input" type="text" value="${formatMoney(item.total)}" disabled />
        </div>
        <div>
          <label class="label">Current Balance</label>
          <input class="input" type="text" value="${formatMoney(balance)}" disabled />
        </div>
      </div>
      <div>
        <label class="label" for="paymentAmount">Amount Received</label>
        <input class="input" id="paymentAmount" type="number" min="0" value="${balance}" />
      </div>
      <div>
        <label class="label" for="paymentMethod">Payment Method</label>
        <select class="input select" id="paymentMethod">
          <option>Cash</option>
          <option>GCash</option>
          <option>Card</option>
        </select>
      </div>
      <div class="form-actions-inline">
        <button class="btn primary" type="button" id="savePaymentBtn">Save Payment</button>
      </div>
    </div>
  `);

  qs("#savePaymentBtn").addEventListener("click", () => {
    const amount = Number(qs("#paymentAmount").value || 0);
    const method = qs("#paymentMethod").value;

    if (amount <= 0) {
      showToast("Enter a valid payment amount.", "error");
      return;
    }

    item.paid = Number(item.paid || 0) + amount;
    item.method = method;

    if (item.paid >= Number(item.total || 0)) {
      item.paymentStatus = "Paid";
      item.paid = Number(item.total || 0);
    } else {
      item.paymentStatus = "Partial";
    }

    saveState();
    closeSharedModal();
    addNotification("Payment Recorded", `Payment for ${item.patient} was recorded.`);
    showToast("Payment recorded successfully.", "success");
    renderAll();
  });
}

function openPatientModal(id = null) {
  const item = id ? state.patients.find(x => x.id === id) : null;

  openSharedModal(item ? "Edit Patient" : "Add Patient", `
    <div class="form-grid one">
      <div>
        <label class="label" for="patientNameInput">Full Name</label>
        <input class="input" id="patientNameInput" type="text" value="${escapeAttr(item?.name || "")}" />
      </div>
      <div class="form-grid two">
        <div>
          <label class="label" for="patientAgeInput">Age</label>
          <input class="input" id="patientAgeInput" type="number" min="0" value="${escapeAttr(String(item?.age || ""))}" />
        </div>
        <div>
          <label class="label" for="patientGenderInput">Gender</label>
          <select class="input select" id="patientGenderInput">
            <option ${item?.gender === "Male" ? "selected" : ""}>Male</option>
            <option ${item?.gender === "Female" ? "selected" : ""}>Female</option>
          </select>
        </div>
      </div>
      <div>
        <label class="label" for="patientConditionInput">Condition</label>
        <input class="input" id="patientConditionInput" type="text" value="${escapeAttr(item?.condition || "")}" />
      </div>
      <div>
        <label class="label" for="patientAddressInput">Address</label>
        <input class="input" id="patientAddressInput" type="text" value="${escapeAttr(item?.address || "")}" />
      </div>
      <div>
        <label class="label" for="patientContactInput">Contact</label>
        <input class="input" id="patientContactInput" type="text" value="${escapeAttr(item?.contact || "")}" />
      </div>
      <div class="form-actions-inline">
        <button class="btn primary" type="button" id="savePatientBtn">${item ? "Update" : "Save"} Patient</button>
      </div>
    </div>
  `);

  qs("#savePatientBtn").addEventListener("click", () => {
    const name = qs("#patientNameInput").value.trim();
    const age = Number(qs("#patientAgeInput").value || 0);
    const gender = qs("#patientGenderInput").value;
    const condition = qs("#patientConditionInput").value.trim();
    const address = qs("#patientAddressInput").value.trim();
    const contact = qs("#patientContactInput").value.trim();

    if (!name || !condition || !address || !contact) {
      showToast("Please fill all patient fields.", "error");
      return;
    }

    if (item) {
      Object.assign(item, { name, age, gender, condition, address, contact });
    } else {
      state.patients.push({ id: uid(), name, age, gender, condition, address, contact });
    }

    saveState();
    closeSharedModal();
    addNotification(item ? "Patient Updated" : "Patient Added", `${name} record was saved.`);
    showToast(item ? "Patient updated." : "Patient added.", "success");
    renderAll();
  });
}

function updateAppointmentStatus(id, status) {
  const item = state.appointments.find(a => a.id === id);
  if (!item) return;

  item.status = status;
  saveState();
  closeAllDropdowns();
  addNotification("Appointment Updated", `${item.patient} status changed to ${status}.`);
  showToast(`Status updated to ${status}.`, "success");
  renderAll();
}

function deletePatient(id) {
  const item = state.patients.find(x => x.id === id);
  if (!item) return;

  openConfirmModal(
    "Delete Patient",
    `Are you sure you want to delete patient "${item.name}"? This action cannot be undone.`,
    () => {
      state.patients = state.patients.filter(x => x.id !== id);
      saveState();
      addNotification("Patient Deleted", `${item.name} record was removed.`);
      showToast("Patient deleted.", "success");
      renderAll();
    }
  );
}

function showPatientView(id) {
  const p = state.patients.find(x => x.id === id);
  if (!p) return;

  openViewModal(
    p.name,
    `
      <div class="detail-list">
        <div class="detail-box"><strong>Age</strong>${p.age} yrs old</div>
        <div class="detail-box"><strong>Gender</strong>${escapeHtml(p.gender)}</div>
        <div class="detail-box"><strong>Condition</strong>${escapeHtml(p.condition)}</div>
        <div class="detail-box"><strong>Address</strong>${escapeHtml(p.address)}</div>
        <div class="detail-box"><strong>Contact</strong>${escapeHtml(p.contact)}</div>
      </div>
    `
  );
}

function showAppointmentView(id) {
  const a = state.appointments.find(x => x.id === id);
  if (!a) return;

  openViewModal(
    a.patient,
    `
      <div class="detail-list">
        <div class="detail-box"><strong>Service</strong>${escapeHtml(a.service)}</div>
        <div class="detail-box"><strong>Dentist</strong>${escapeHtml(a.dentist)}</div>
        <div class="detail-box"><strong>Schedule</strong>${formatDate(a.date)} • ${formatTime(a.time)}</div>
        <div class="detail-box"><strong>Status</strong>${statusBadge(a.status)}</div>
        <div class="detail-box"><strong>Total</strong>${formatMoney(a.total)}</div>
        <div class="detail-box"><strong>Paid</strong>${formatMoney(a.paid)}</div>
        <div class="detail-box"><strong>Refunded</strong>${formatMoney(getTotalRefunded(a))}</div>
        <div class="detail-box"><strong>Payment</strong>${paymentBadge(a.paymentStatus)}</div>
      </div>
    `
  );
}

function openSharedModal(title, content) {
  qs("#modalTitle").textContent = title;
  qs("#modalBody").innerHTML = content;
  qs("#modalBackdrop").classList.remove("hidden");
}

function closeSharedModal() {
  qs("#modalBackdrop").classList.add("hidden");
  qs("#modalBody").innerHTML = "";
}

function openViewModal(title, content) {
  qs("#viewTitle").textContent = title;
  qs("#viewBody").innerHTML = content;
  qs("#viewBackdrop").classList.remove("hidden");
}

function closeViewModal() {
  qs("#viewBackdrop").classList.add("hidden");
  qs("#viewBody").innerHTML = "";
}

function openConfirmModal(title, message, onConfirm) {
  const content = `
    <div class="confirm-modal">
      <p>${message}</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="confirmCancelBtn">Cancel</button>
        <button class="btn btn-danger" id="confirmOkBtn">Confirm</button>
      </div>
    </div>
  `;

  openSharedModal(title, content);

  // Attach event listeners
  qs("#confirmCancelBtn").addEventListener("click", () => {
    closeSharedModal();
  });

  qs("#confirmOkBtn").addEventListener("click", () => {
    closeSharedModal();
    onConfirm();
  });
}

function toggleDropdown(menu, anchor) {
  const isOpen = menu.classList.contains("show");
  closeAllDropdowns();
  if (isOpen) return;

  menu.classList.add("show");
  menu.classList.remove("up");

  const menuHeight = menu.offsetHeight || 120;
  const anchorRect = anchor.getBoundingClientRect();
  const bottomSpace = window.innerHeight - (anchorRect.bottom + menuHeight + 8);

  if (bottomSpace < 0) {
    menu.classList.add("up");
  }
}

function closeAllDropdowns() {
  qsa(".dropdown").forEach(d => d.classList.remove("show", "up"));
}

function closeFloatingMenus() {
  qsa(".menu-panel").forEach(p => p.classList.remove("show"));
  closeAllDropdowns();
}

document.addEventListener("click", e => {
  if (!e.target.closest(".menu-wrap") && !e.target.closest(".action-menu-cell")) {
    closeAllDropdowns();
  }
});

function statusBadge(status) {
  const key = String(status).toLowerCase();
  let cls = "status-confirmed";

  if (key === "waiting" || key === "pending") cls = "status-waiting";
  else if (key === "confirmed" || key === "approved") cls = "status-confirmed";
  else if (key === "in progress") cls = "status-progress";
  else if (key === "completed") cls = "status-completed";
  else if (key === "cancelled") cls = "status-cancelled";
  else if (key === "rejected") cls = "status-rejected";

  return `<span class="status-pill ${cls}">${escapeHtml(status)}</span>`;
}

// Premium/stability overrides
function renderQueue() {
  const tbody = qs("#queueTable");
  if (!tbody) return;
  tbody.innerHTML = "";

  const items = (state.appointments || [])
    .filter(item => item.date === todayISO())
    .sort((a, b) => safeText(a.time).localeCompare(safeText(b.time)));

  if (!items.length) {
    tbody.innerHTML = tableEmptyRow(7, "No queue items found", "Today's active queue will appear here.", "bi-people");
    return;
  }

  items.forEach((item, index) => {
    const safeStatus = normalizedStatus(item.status);
    const canConfirm = !["confirmed", "in-progress", "completed", "cancelled", "rejected"].includes(statusClassName(safeStatus));
    const canProgress = statusClassName(safeStatus) === "confirmed";
    const canComplete = ["confirmed", "in-progress"].includes(statusClassName(safeStatus));
    const canCancel = !isClosedStaffStatus(safeStatus);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(safeText(item.patient, "Unknown Patient"))}</td>
      <td>${escapeHtml(safeText(item.service, "Consultation"))}</td>
      <td>${escapeHtml(safeText(item.dentist, "Unassigned"))}</td>
      <td>${formatTime(item.time)}</td>
      <td>#${index + 1}</td>
      <td>${statusBadge(safeStatus)}</td>
      <td class="action-menu-cell">
        <button class="kebab-btn" type="button" aria-label="Open queue actions"><i class="bi bi-three-dots-vertical"></i></button>
        <div class="dropdown">
          ${canConfirm ? `<button type="button" data-action="confirm">Mark Confirmed</button>` : ""}
          ${canProgress ? `<button type="button" data-action="progress">Start Service</button>` : ""}
          ${canComplete ? `<button type="button" data-action="complete">Mark Completed</button>` : ""}
          ${canCancel ? `<button type="button" class="danger-text" data-action="cancel">Cancel</button>` : ""}
          ${!canConfirm && !canProgress && !canComplete && !canCancel ? `<button type="button" disabled>No actions available</button>` : ""}
        </div>
      </td>
    `;

    const kebab = tr.querySelector(".kebab-btn");
    const menu = tr.querySelector(".dropdown");
    safeOn(kebab, "click", (e) => {
      e.stopPropagation();
      toggleDropdown(menu, kebab);
    });
    safeOn(menu?.querySelector('[data-action="confirm"]'), "click", () => updateAppointmentStatus(item.id, "Confirmed"));
    safeOn(menu?.querySelector('[data-action="progress"]'), "click", () => updateAppointmentStatus(item.id, "In Progress"));
    safeOn(menu?.querySelector('[data-action="complete"]'), "click", () => updateAppointmentStatus(item.id, "Completed"));
    safeOn(menu?.querySelector('[data-action="cancel"]'), "click", () => updateAppointmentStatus(item.id, "Cancelled"));

    tbody.appendChild(tr);
  });
}

function renderAppointments() {
  const tbody = qs("#appointmentsTable");
  if (!tbody) return;
  tbody.innerHTML = "";

  const search = safeValue(qs("#appointmentSearch")).trim().toLowerCase();
  const filter = safeValue(qs("#appointmentFilter"));
  const dateFilter = safeValue(qs("#appointmentDateFilter")) || "all";
  const dateSpecific = safeValue(qs("#appointmentDateSpecific"));
  let items = [...(state.appointments || [])];

  if (search) {
    items = items.filter(item =>
      safeText(item.patient, "").toLowerCase().includes(search) ||
      safeText(item.service, "").toLowerCase().includes(search) ||
      safeText(item.dentist, "").toLowerCase().includes(search)
    );
  }

  if (filter) {
    items = items.filter(item => normalizedStatus(item.status) === filter);
  }

  items = items.filter(item => isStaffRecordInDateFilter(item, dateFilter, dateSpecific));

  items.sort((a, b) => dateTimeValue(a.date, a.time) - dateTimeValue(b.date, b.time));

  if (!items.length) {
    tbody.innerHTML = tableEmptyRow(7, "No appointments found", "Try adjusting the search or status filter.", "bi-calendar2-x");
    return;
  }

  items.forEach(item => {
    const safeStatus = normalizedStatus(item.status);
    const closed = isClosedStaffStatus(safeStatus);
    const paymentAllowed = safeText(item.paymentStatus, "Unpaid") !== "Paid" && statusClassName(safeStatus) !== "cancelled";

    const tr = document.createElement("tr");
    tr.className = `appointment-table-row${item.date === todayISO() ? " is-today" : ""}`;
    tr.innerHTML = `
      <td><div class="table-identity"><strong>${escapeHtml(safeText(item.patient, "Unknown Patient"))}</strong><span>${item.date === todayISO() ? "Today" : "Patient Record"}</span></div></td>
      <td><div class="table-identity"><strong>${escapeHtml(safeText(item.dentist, "Unassigned"))}</strong><span>Dentist</span></div></td>
      <td><div class="table-service"><span class="service-mark"><i class="bi bi-shield-plus"></i></span><span>${escapeHtml(safeText(item.service, "Consultation"))}</span></div></td>
      <td><span class="table-muted">${formatDate(item.date)}</span></td>
      <td><span class="table-muted">${formatTime(item.time)}</span></td>
      <td>${statusBadge(safeStatus)}</td>
      <td class="action-menu-cell">
        <button class="kebab-btn" type="button" aria-label="Open appointment actions"><i class="bi bi-three-dots-vertical"></i></button>
        <div class="dropdown">
          ${closed ? "" : `<button type="button" data-action="edit">Edit</button>`}
          ${paymentAllowed ? `<button type="button" data-action="payment">Record Payment</button>` : ""}
          <button type="button" data-action="view">View</button>
          ${closed ? "" : `<button type="button" class="danger-text" data-action="cancel">Cancel</button>`}
        </div>
      </td>
    `;

    const kebab = tr.querySelector(".kebab-btn");
    const menu = tr.querySelector(".dropdown");
    safeOn(kebab, "click", (e) => {
      e.stopPropagation();
      toggleDropdown(menu, kebab);
    });
    safeOn(menu?.querySelector('[data-action="edit"]'), "click", () => openAppointmentModal(item.id));
    safeOn(menu?.querySelector('[data-action="payment"]'), "click", () => openPaymentModal(item.id));
    safeOn(menu?.querySelector('[data-action="view"]'), "click", () => showAppointmentView(item.id));
    safeOn(menu?.querySelector('[data-action="cancel"]'), "click", () => updateAppointmentStatus(item.id, "Cancelled"));
    tbody.appendChild(tr);
  });
}

function parseStaffRecordDateValue(record = {}) {
  const scheduleText = String(record.schedule || "");
  const scheduleDate = (scheduleText.match(/\d{4}-\d{2}-\d{2}/) || [])[0] ||
    scheduleText.split(/[•\u2022]/)[0]?.trim() ||
    "";
  const raw = record.date || record.appointmentDate || scheduleDate || record.createdAt || record.updatedAt || "";
  if (!raw) return null;
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return date;
  const embeddedDate = (String(raw).match(/\d{4}-\d{2}-\d{2}/) || [])[0];
  if (!embeddedDate) return null;
  const fallback = new Date(`${embeddedDate}T00:00:00`);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function isStaffRecordInDateFilter(record, filterValue, specificDateValue) {
  const filter = filterValue || "all";
  if (filter === "all") return true;

  const date = parseStaffRecordDateValue(record);
  if (!date) return false;

  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date();
  const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (filter === "day") {
    if (!specificDateValue) return true;
    const selected = new Date(`${specificDateValue}T00:00:00`);
    return dateOnly.getTime() === selected.getTime();
  }

  if (filter === "month") {
    return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth();
  }

  if (filter === "week") {
    const weekStart = new Date(todayOnly);
    weekStart.setDate(todayOnly.getDate() - todayOnly.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    return dateOnly >= weekStart && dateOnly <= weekEnd;
  }

  return true;
}

function syncStaffDateFilterInput() {
  const select = qs("#appointmentDateFilter");
  const input = qs("#appointmentDateSpecific");
  if (!select || !input) return;
  input.classList.toggle("hidden", select.value !== "day");
}

function syncStaffReportDateFilterInput() {
  const select = qs("#reportDateFilter");
  const input = qs("#reportDateSpecific");
  if (!select || !input) return;
  input.classList.toggle("hidden", select.value !== "day");
}

function staffCsvValue(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadStaffCsv(filename, headers, rows) {
  const csv = [
    headers.map(staffCsvValue).join(","),
    ...rows.map(row => headers.map(header => staffCsvValue(row[header])).join(","))
  ].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function getStaffReportDateFilter() {
  return {
    mode: safeValue(qs("#reportDateFilter")) || safeValue(qs("#appointmentDateFilter")) || "all",
    day: safeValue(qs("#reportDateSpecific")) || safeValue(qs("#appointmentDateSpecific"))
  };
}

function uniqueStaffRecords(records) {
  const seen = new Set();
  return safeArray(records).filter(item => {
    const key = String(item.id || `${item.patient || item.patientName || ""}-${item.service || ""}-${item.date || item.schedule || item.createdAt || item.time || ""}-${item.status || item.title || item.body || item.message || ""}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getStaffReportAppointments({ includeArchived = false, terminalOnly = false, visitsOnly = false } = {}) {
  const db = getClinicDb();
  const records = uniqueStaffRecords([
    ...safeArray(state.appointments),
    ...safeArray(db.appointments),
    ...(includeArchived ? safeArray(db.archivedAppointments) : [])
  ]);
  const dateFilter = getStaffReportDateFilter();

  return records.filter(item => {
    if (!includeArchived && item.archived) return false;
    if (!isStaffRecordInDateFilter(item, dateFilter.mode, dateFilter.day)) return false;

    const status = normalizedStatus(item.status || item.lifecycleStatus || "");
    if (terminalOnly && !["Completed", "Cancelled", "Rejected", "Reschedule Rejected"].includes(status)) return false;
    if (visitsOnly && !(item.patient || item.patientName) && !(item.date || item.schedule)) return false;
    return true;
  });
}

function staffReportDateText(record = {}) {
  const explicit = record.date || record.appointmentDate || "";
  if (explicit) return explicit;
  const parsed = parseStaffRecordDateValue(record);
  if (!parsed) return "";
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

function staffReportTimeText(record = {}) {
  if (record.time) return record.time;
  const schedule = String(record.schedule || "");
  const withoutDate = schedule.replace(/^\s*\d{4}-\d{2}-\d{2}\s*(?:[•\u2022-]\s*)?/, "").trim();
  if (withoutDate && withoutDate !== schedule) return withoutDate;
  const parts = schedule.split(/[•\u2022]/).map(part => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" - ") : "";
}

function getStaffPatientMap() {
  const patientMap = new Map();
  const db = getClinicDb();
  [...safeArray(state.patients), ...safeArray(db.patients)].forEach(patient => {
    [patient.id, patient.name, patient.email, patient.contact, patient.phone]
      .filter(Boolean)
      .forEach(key => patientMap.set(String(key).toLowerCase(), patient));
  });
  return patientMap;
}

function resolveStaffPatient(patientMap, item = {}) {
  return patientMap.get(String(item.patientId || "").toLowerCase()) ||
    patientMap.get(String(item.patient || "").toLowerCase()) ||
    patientMap.get(String(item.patientName || "").toLowerCase()) ||
    patientMap.get(String(item.patientEmail || "").toLowerCase()) ||
    patientMap.get(String(item.patientPhone || "").toLowerCase()) ||
    {};
}

function staffPaidAmount(item = {}) {
  if (typeof item.paid === "number") return Number(item.paid || 0);
  return Number(item.totalCollected || item.amountPaidOnline || item.amountPaidInClinic || 0);
}

function buildStaffAppointmentReportRows(records = getStaffReportAppointments()) {
  const patientMap = getStaffPatientMap();
  return records
    .sort((a, b) => dateTimeValue(a.date, a.time) - dateTimeValue(b.date, b.time))
    .map(item => {
      const patient = resolveStaffPatient(patientMap, item);
      const total = Number(item.total || item.price || item.amount || 0);
      const paid = staffPaidAmount(item);
      return {
        "Patient": item.patient || item.patientName || patient.name || "Unknown Patient",
        "Email": patient.email || item.patientEmail || "",
        "Phone": patient.contact || patient.phone || item.patientPhone || "",
        "Dentist": item.dentist || item.dentistName || "",
        "Service": item.service || item.serviceName || "",
        "Date": staffReportDateText(item),
        "Time": staffReportTimeText(item),
        "Status": normalizedStatus(item.status || item.lifecycleStatus || ""),
        "Total": total,
        "Paid": paid,
        "Balance": Math.max(0, total - paid),
        "Payment Status": item.paymentStatus || ""
      };
    });
}

function buildStaffTreatmentHistoryRows() {
  const db = getClinicDb();
  const appointmentRows = getStaffReportAppointments({ includeArchived: true })
    .map(item => {
      return {
        "Record Type": "Appointment Treatment Record",
        "Patient": item.patient || item.patientName || "Unknown Patient",
        "Dentist": item.dentist || item.dentistName || "",
        "Treatment/Service": item.service || item.serviceName || "",
        "Date": item.date || item.schedule || item.updatedAt || "",
        "Status": normalizedStatus(item.status || ""),
        "Notes": item.notes || item.cancelReason || item.rejectionReason || ""
      };
    });

  const planRows = safeArray(db.treatmentPlans).map(plan => ({
    "Record Type": "Treatment Plan",
    "Patient": plan.patientName || plan.patient || "Unknown Patient",
    "Dentist": plan.dentistName || plan.dentist || "",
    "Treatment/Service": plan.serviceName || plan.service || "Treatment",
    "Date": plan.startDate || plan.createdAt || plan.updatedAt || "",
    "Status": plan.status || "",
    "Notes": plan.notes || plan.discontinuationReason || plan.consultationNote || ""
  }));

  const noteRows = safeArray(db.patientClinicalNotes).map(note => ({
    "Record Type": "Clinical Note",
    "Patient": note.patientName || note.patient || "Unknown Patient",
    "Dentist": note.dentistName || note.dentist || "",
    "Treatment/Service": note.service || note.title || "Clinical Note",
    "Date": note.createdAt || note.updatedAt || "",
    "Status": note.status || "",
    "Notes": note.note || note.finding || note.notes || ""
  }));

  const historyRows = safeArray(db.history).map(item => ({
    "Record Type": item.recordType || "History",
    "Patient": item.patientName || item.patient || "Unknown Patient",
    "Dentist": item.dentistName || item.dentist || "",
    "Treatment/Service": item.serviceName || item.service || item.title || "History",
    "Date": item.date || item.schedule || item.createdAt || item.updatedAt || "",
    "Status": item.status || "",
    "Notes": item.notes || item.note || item.description || ""
  }));

  return [...appointmentRows, ...planRows, ...noteRows, ...historyRows].filter(row => {
    const dateFilter = getStaffReportDateFilter();
    return isStaffRecordInDateFilter({ date: row["Date"] }, dateFilter.mode, dateFilter.day);
  });
}

function buildStaffActivityRows() {
  const db = getClinicDb();
  const notificationGroups = db.notifications || {};
  const sharedActivities = ["admin", "staff", "dentist", "patient"].flatMap(role =>
    safeArray(notificationGroups[role]).map(item => ({ ...item, role }))
  );
  const localActivities = safeArray(state.notifications).map(item => ({ ...item, role: "staff" }));
  const appointmentActivities = getStaffReportAppointments({ includeArchived: true }).map(item => ({
    id: `appointment-activity-${item.id || `${item.patient || item.patientName || ""}-${item.date || item.schedule || ""}`}`,
    role: item.createdByRole || item.updatedByRole || "clinic",
    createdAt: item.updatedAt || item.createdAt || item.date || item.schedule || "",
    title: "Appointment Record",
    body: `${item.patient || item.patientName || "Unknown Patient"} - ${item.service || "Appointment"} - ${normalizedStatus(item.status || "")}`,
    read: true
  }));
  const dateFilter = getStaffReportDateFilter();

  return uniqueStaffRecords([...localActivities, ...sharedActivities, ...appointmentActivities])
    .filter(item => isStaffRecordInDateFilter({ date: item.createdAt || item.date || item.time }, dateFilter.mode, dateFilter.day))
    .map(item => ({
      "Date": item.createdAt || item.date || item.time || "",
      "Role": item.role || "staff",
      "Title": item.title || item.eventType || "Activity",
      "Activity": item.body || item.text || item.message || "",
      "Read": item.read === false ? "No" : "Yes"
    }));
}

function buildStaffSummaryRows() {
  const appointments = getStaffReportAppointments({ includeArchived: true });
  const visits = getStaffReportAppointments({ includeArchived: true, visitsOnly: true });
  const treatments = buildStaffTreatmentHistoryRows();
  const activities = buildStaffActivityRows();
  const revenue = appointments.reduce((sum, item) => sum + staffPaidAmount(item), 0);
  const dateFilter = getStaffReportDateFilter();
  const scope = dateFilter.mode === "day" && dateFilter.day ? dateFilter.day : dateFilter.mode;

  return [
    { "Category": "Appointments", "Metric": "Total appointment records", "Value": appointments.length, "Scope": scope },
    { "Category": "Appointments", "Metric": "Pending appointments", "Value": appointments.filter(item => normalizedStatus(item.status) === "Pending").length, "Scope": scope },
    { "Category": "Patient Visits", "Metric": "Completed or active visits", "Value": visits.length, "Scope": scope },
    { "Category": "Treatment Histories", "Metric": "Treatment/history records", "Value": treatments.length, "Scope": scope },
    { "Category": "Record Activities", "Metric": "Activity records", "Value": activities.length, "Scope": scope },
    { "Category": "Billing", "Metric": "Collected amount", "Value": revenue, "Scope": scope }
  ];
}

function buildStaffPatientDirectoryRows() {
  const db = getClinicDb();
  const patientMap = new Map();
  [...safeArray(state.patients), ...safeArray(db.patients)].forEach(patient => {
    const key = String(patient.id || patient.name || patient.email || patient.contact || "").toLowerCase();
    if (!key || patientMap.has(key)) return;
    patientMap.set(key, patient);
  });

  return [...patientMap.values()].map(patient => ({
    "Name": patient.name || "Unnamed Patient",
    "Email": patient.email || "",
    "Phone": patient.contact || patient.phone || patient.mobile || "",
    "Status": patient.archived ? "Inactive" : "Active",
    "Created Date": formatCreatedDate(patient.createdAt || patient.updatedAt || patient.dateCreated || patient.registeredAt)
  }));
}

function getStaffReportConfig(type = safeValue(qs("#reportExportType")) || "patients") {
  const configs = {
    patients: {
      filename: `patient-records-${todayISO()}.csv`,
      headers: ["Name", "Email", "Phone", "Status", "Created Date"],
      rows: buildStaffPatientDirectoryRows()
    },
    appointments: {
      filename: `appointments-report-${todayISO()}.csv`,
      headers: ["Patient", "Email", "Phone", "Dentist", "Service", "Date", "Time", "Status", "Total", "Paid", "Balance", "Payment Status"],
      rows: buildStaffAppointmentReportRows(getStaffReportAppointments({ includeArchived: true }))
    },
    visits: {
      filename: `patient-visits-report-${todayISO()}.csv`,
      headers: ["Patient", "Email", "Phone", "Dentist", "Service", "Date", "Time", "Status", "Total", "Paid", "Balance", "Payment Status"],
      rows: buildStaffAppointmentReportRows(getStaffReportAppointments({ includeArchived: true, visitsOnly: true }))
    },
    treatments: {
      filename: `treatment-histories-report-${todayISO()}.csv`,
      headers: ["Record Type", "Patient", "Dentist", "Treatment/Service", "Date", "Status", "Notes"],
      rows: buildStaffTreatmentHistoryRows()
    },
    activities: {
      filename: `record-activities-report-${todayISO()}.csv`,
      headers: ["Date", "Role", "Title", "Activity", "Read"],
      rows: buildStaffActivityRows()
    },
    summary: {
      filename: `all-reports-summary-${todayISO()}.csv`,
      headers: ["Category", "Metric", "Value", "Scope"],
      rows: buildStaffSummaryRows()
    }
  };

  return configs[type] || configs.patients;
}

function renderStaffReportPreviewIfNeeded() {
  const type = safeValue(qs("#reportExportType")) || "patients";
  if (type === "patients") return false;

  const table = qs("#patientsTable")?.closest("table");
  const tbody = qs("#patientsTable");
  const headerRow = table?.querySelector("thead tr");
  if (!table || !tbody || !headerRow) return false;

  const config = getStaffReportConfig(type);
  headerRow.innerHTML = config.headers.map(header => `<th>${escapeHtml(header)}</th>`).join("");
  tbody.innerHTML = "";

  if (!config.rows.length) {
    tbody.innerHTML = tableEmptyRow(config.headers.length, "No matching records", "Try another report type or date filter.", "bi-file-earmark-spreadsheet");
    return true;
  }

  config.rows.forEach(row => {
    const tr = document.createElement("tr");
    tr.className = "appointment-table-row entity-table-row";
    tr.innerHTML = config.headers.map(header => `<td><span class="table-cell-muted">${escapeHtml(row[header] ?? "")}</span></td>`).join("");
    tbody.appendChild(tr);
  });

  return true;
}

function exportPatientRecordsCsv() {
  const config = getStaffReportConfig();

  if (!config.rows.length) {
    showToast("No matching records to export.", "error");
    return;
  }

  downloadStaffCsv(config.filename, config.headers, config.rows);
}

function syncStaffRevenueDateFilterInput() {
  const select = qs("#revenueDateFilter");
  const input = qs("#revenueDateSpecific");
  if (!select || !input) return;
  input.classList.toggle("hidden", select.value !== "day");
}

function parseStaffRevenueDate(record = {}) {
  const raw = record.paidAt || record.paymentDate || record.lastPaymentAt || record.updatedAt || record.completedAt || record.date || record.schedule || "";
  const embedded = (String(raw).match(/\d{4}-\d{2}-\d{2}/) || [])[0];
  const date = new Date(embedded ? `${embedded}T00:00:00` : raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function matchesStaffRevenueFilter(record = {}) {
  const filter = safeValue(qs("#revenueDateFilter")) || "year";
  const specific = safeValue(qs("#revenueDateSpecific"));
  const date = parseStaffRevenueDate(record);
  if (!date) return false;

  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date();
  const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (filter === "day") {
    if (!specific) return true;
    return dateOnly.getTime() === new Date(`${specific}T00:00:00`).getTime();
  }

  if (filter === "week") {
    const weekStart = new Date(todayOnly);
    weekStart.setDate(todayOnly.getDate() - todayOnly.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    return dateOnly >= weekStart && dateOnly <= weekEnd;
  }

  if (filter === "month") {
    return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth();
  }

  return date.getFullYear() === today.getFullYear();
}

function getStaffRevenueRecords() {
  const db = getClinicDb();
  const appointmentRecords = [...safeArray(state.appointments), ...safeArray(db.appointments)];
  const treatmentRevenueRecords = safeArray(db.treatmentPlans).map(plan => ({
    ...plan,
    id: `treatment-revenue-${plan.treatmentId || plan.id || uid()}`,
    patient: plan.patientName || plan.patient || "",
    dentist: plan.dentistName || plan.dentist || "",
    service: plan.serviceName || plan.service || "Treatment Plan",
    date: plan.lastPaymentAt || plan.paidAt || plan.updatedAt || plan.startDate || plan.createdAt || "",
    paymentMethod: plan.paymentMethod || "",
    paymentStatus: plan.paymentStatus || (Number(plan.remainingBalance || 0) <= 0 ? "Paid" : Number(plan.amountPaid || plan.totalCollected || 0) > 0 ? "Partial" : "Unpaid"),
    amountPaidOnline: Number(plan.amountPaidOnline || 0),
    amountPaidInClinic: Number(plan.amountPaidInClinic || 0),
    totalCollected: Number(plan.totalCollected || plan.amountPaid || 0)
  }));

  return uniqueStaffRecords([...appointmentRecords, ...treatmentRevenueRecords])
    .map(item => {
      const online = Number(item.amountPaidOnline || 0);
      const clinic = Number(item.amountPaidInClinic || 0);
      const collected = Number(item.totalCollected ?? (online + clinic) ?? 0);
      const paid = collected || (typeof item.paid === "number" ? Number(item.paid || 0) : 0);
      return {
        ...item,
        revenueOnline: online,
        revenueClinic: clinic,
        revenueCollected: paid
      };
    })
    .filter(item => item.revenueCollected > 0 && matchesStaffRevenueFilter(item));
}

function renderRevenue() {
  const tbody = qs("#revenueTable");
  if (!tbody) return;

  const records = getStaffRevenueRecords()
    .sort((left, right) => (parseStaffRevenueDate(right)?.getTime() || 0) - (parseStaffRevenueDate(left)?.getTime() || 0));
  const total = records.reduce((sum, item) => sum + Number(item.revenueCollected || 0), 0);
  const online = records.reduce((sum, item) => sum + Number(item.revenueOnline || 0), 0);
  const clinic = records.reduce((sum, item) => sum + Number(item.revenueClinic || 0), 0);

  if (qs("#revenueTotal")) qs("#revenueTotal").textContent = formatMoney(total);
  if (qs("#revenueOnline")) qs("#revenueOnline").textContent = formatMoney(online);
  if (qs("#revenueClinic")) qs("#revenueClinic").textContent = formatMoney(clinic || Math.max(0, total - online));

  tbody.innerHTML = "";

  if (!records.length) {
    tbody.innerHTML = tableEmptyRow(7, "No revenue records", "Payments collected in the selected period will appear here.", "bi-cash-stack");
    return;
  }

  records.forEach(item => {
    const date = parseStaffRevenueDate(item);
    const dateText = date
      ? date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
      : "-";
    const method = item.paymentMethod || item.method || (item.revenueOnline > 0 ? "GCash" : item.revenueClinic > 0 ? "Cash" : "-");
    const tr = document.createElement("tr");
    tr.className = "appointment-table-row entity-table-row";
    tr.innerHTML = `
      <td><div class="table-identity"><strong>${escapeHtml(safeText(item.patient || item.patientName, "Unknown Patient"))}</strong><span>Patient payment</span></div></td>
      <td><span class="table-cell-muted">${escapeHtml(safeText(item.dentist || item.dentistName, "-"))}</span></td>
      <td><span class="table-cell-muted">${escapeHtml(safeText(item.service || item.serviceName, "-"))}</span></td>
      <td><span class="table-muted">${escapeHtml(dateText)}</span></td>
      <td><span class="table-cell-muted">${escapeHtml(method)}</span></td>
      <td><strong>${formatMoney(item.revenueCollected)}</strong></td>
      <td>${paymentBadge(item.paymentStatus || "Paid")}</td>
    `;
    tbody.appendChild(tr);
  });
}

function getTotalRefunded(appointment) {
  return safeArray(appointment?.refunds).reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
}

function getRefundableAmount(appointment) {
  const paid = Number(appointment?.totalCollected ?? appointment?.paid ?? 0);
  return Math.max(0, paid - getTotalRefunded(appointment));
}

function isRefundableAppointment(appointment) {
  const status = statusClassName(normalizedStatus(appointment?.status));
  return status === "cancelled" && getRefundableAmount(appointment) > 0;
}

function openRefundModal(id) {
  const item = (state.appointments || []).find(x => String(x.id) === String(id));
  if (!item) {
    showToast("Appointment record not found.", "error");
    return;
  }

  if (!isRefundableAppointment(item)) {
    showToast("Only cancelled paid appointments can be refunded.", "error");
    return;
  }

  const refundable = getRefundableAmount(item);
  const alreadyRefunded = getTotalRefunded(item);
  const preferredMethod = String(item.preferredRefundMethod || "").trim();
  const preferredGcash = String(item.refundGcashNumber || "").trim();
  const preferredLabel = preferredMethod
    ? `${preferredMethod}${preferredGcash ? ` (${preferredGcash})` : ""}`
    : "No patient choice yet";

  openSharedModal("Process Refund", `
    <div class="form-grid one">
      <div class="detail-box refund-summary">
        <strong>${escapeHtml(safeText(item.patient, "Unknown Patient"))}</strong>
        <div>${escapeHtml(safeText(item.service, "Appointment"))} &bull; ${escapeHtml(safeText(item.dentist, "Unassigned"))}</div>
        <div>${formatDate(item.date)} &bull; ${formatTime(item.time)}</div>
      </div>
      <div class="form-grid three">
        <div class="detail-box"><strong>Total Paid</strong>${formatMoney(item.paid)}</div>
        <div class="detail-box"><strong>Already Refunded</strong>${formatMoney(alreadyRefunded)}</div>
        <div class="detail-box"><strong>Refundable</strong>${formatMoney(refundable)}</div>
      </div>
      <div class="detail-box">
        <strong>Patient Preferred Method</strong>
        ${escapeHtml(preferredLabel)}
      </div>
      <div>
        <label class="label" for="refundAmount">Refund Amount</label>
        <input class="input" id="refundAmount" type="number" min="0.01" max="${refundable}" step="0.01" value="${refundable}" />
      </div>
      <div>
        <label class="label" for="refundMethod">Refund Method</label>
        <select class="input select" id="refundMethod">
          <option value="">Select method</option>
          <option value="Cash" ${preferredMethod === "Cash" ? "selected" : ""}>Cash</option>
          <option value="GCash" ${preferredMethod === "GCash" ? "selected" : ""}>GCash</option>
        </select>
      </div>
      <div>
        <label class="label" for="refundNote">Note</label>
        <textarea class="input" id="refundNote" rows="3" placeholder="Reason or additional notes"></textarea>
      </div>
      <div class="form-actions-inline">
        <button class="btn primary" type="button" id="saveRefundBtn">Confirm Refund</button>
      </div>
    </div>
  `);

  safeOn(qs("#saveRefundBtn"), "click", () => {
    const amount = Number(qs("#refundAmount")?.value || 0);
    const method = safeValue(qs("#refundMethod"));
    const note = safeValue(qs("#refundNote")).trim();

    if (amount <= 0) {
      showToast("Enter a valid refund amount.", "error");
      return;
    }

    if (amount > refundable + 0.001) {
      showToast(`Refund amount cannot exceed ${formatMoney(refundable)}.`, "error");
      return;
    }

    if (!method) {
      showToast("Select a refund method.", "error");
      return;
    }

    processRefund(id, amount, method, note);
  });
}

function pushSharedNotification(target, text, meta = {}) {
  const db = getClinicDb();
  const safeTarget = ["admin", "dentist", "patient", "staff"].includes(target) ? target : "admin";
  db.notifications = db.notifications || { admin: [], dentist: [], patient: [], staff: [] };
  db.notifications[safeTarget] = safeArray(db.notifications[safeTarget]);
  db.notifications[safeTarget].unshift({
    id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text,
    message: text,
    read: false,
    createdAt: new Date().toISOString(),
    ...meta
  });
  saveClinicDb(db);
}

function processRefund(id, amount, method, note = "") {
  const item = (state.appointments || []).find(x => String(x.id) === String(id));
  if (!item) {
    showToast("Appointment record not found.", "error");
    return;
  }

  const refundable = getRefundableAmount(item);
  if (amount > refundable + 0.001) {
    showToast(`Refund amount cannot exceed ${formatMoney(refundable)}.`, "error");
    return;
  }

  const refundRecord = {
    id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    amount: Number(amount),
    method,
    note,
    refundedAt: new Date().toISOString(),
    refundedBy: "staff"
  };

  item.refunds = [...safeArray(item.refunds), refundRecord];
  item.refundMethodPending = false;
  item.preferredRefundMethod = method;
  item.updatedAt = new Date().toISOString();

  saveState();
  closeSharedModal();

  const amountText = Number(amount).toLocaleString();
  addNotification("Refund Processed", `Refund of ${formatMoney(amount)} for ${safeText(item.patient, "patient")} was processed.`);
  pushSharedNotification(
    "patient",
    `A refund of â‚±${amountText} for your ${safeText(item.service, "appointment")} appointment has been processed via ${method}.`,
    { patientId: item.patientId || "", appointmentId: item.id, eventType: "appointment_refunded" }
  );
  pushSharedNotification(
    "dentist",
    `Refund of â‚±${amountText} processed for ${safeText(item.patient, "patient")} via ${method}.`,
    { patientId: item.patientId || "", appointmentId: item.id, eventType: "appointment_refunded" }
  );

  showToast("Refund processed successfully.", "success");
  renderAll();
}

function updateAppointmentStatus(id, status) {
  const item = (state.appointments || []).find(a => a.id === id);
  if (!item) {
    showToast("Appointment record not found.", "error");
    return;
  }

  const nextStatus = normalizedStatus(status);
  if (normalizedStatus(item.status) === nextStatus) {
    closeAllDropdowns();
    return;
  }

  item.status = nextStatus;
  saveState();
  closeAllDropdowns();
  addNotification("Appointment Updated", `${safeText(item.patient, "Patient")} status changed to ${nextStatus}.`);
  showToast(`Status updated to ${nextStatus}.`, "success");
  renderAll();
}

function openSharedModal(title, content) {
  const modalTitle = qs("#modalTitle");
  const modalBody = qs("#modalBody");
  const modalBackdrop = qs("#modalBackdrop");
  if (!modalTitle || !modalBody || !modalBackdrop) return;
  modalTitle.textContent = title;
  modalBody.innerHTML = content;
  modalBackdrop.classList.remove("hidden");
}

function closeSharedModal() {
  const modalBackdrop = qs("#modalBackdrop");
  const modalBody = qs("#modalBody");
  if (modalBackdrop) modalBackdrop.classList.add("hidden");
  if (modalBody) modalBody.innerHTML = "";
}

function openViewModal(title, content) {
  const viewTitle = qs("#viewTitle");
  const viewBody = qs("#viewBody");
  const viewBackdrop = qs("#viewBackdrop");
  if (!viewTitle || !viewBody || !viewBackdrop) return;
  viewTitle.textContent = title;
  viewBody.innerHTML = content;
  viewBackdrop.classList.remove("hidden");
}

function closeViewModal() {
  const viewBackdrop = qs("#viewBackdrop");
  const viewBody = qs("#viewBody");
  if (viewBackdrop) viewBackdrop.classList.add("hidden");
  if (viewBody) viewBody.innerHTML = "";
}

function openConfirmModal(title, message, onConfirm) {
  const content = `
    <div class="confirm-modal">
      <p>${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn secondary" id="confirmCancelBtn" type="button">Cancel</button>
        <button class="btn danger" id="confirmOkBtn" type="button">Confirm</button>
      </div>
    </div>
  `;

  openSharedModal(title, content);
  safeOn(qs("#confirmCancelBtn"), "click", closeSharedModal);
  safeOn(qs("#confirmOkBtn"), "click", () => {
    closeSharedModal();
    if (typeof onConfirm === "function") onConfirm();
  });
}

function toggleDropdown(menu, anchor) {
  if (!menu || !anchor) return;
  const isOpen = menu.classList.contains("show");
  closeAllDropdowns();
  if (isOpen) return;

  const cell = anchor.closest(".action-menu-cell");
  const row = anchor.closest("tr");
  cell?.classList.add("menu-open");
  row?.classList.add("menu-open");

  menu.classList.add("show");
  menu.classList.remove("up");

  requestAnimationFrame(() => {
    const menuHeight = menu.offsetHeight || 180;
    const anchorRect = anchor.getBoundingClientRect();
    const bottomSpace = window.innerHeight - (anchorRect.bottom + menuHeight + 12);
    if (bottomSpace < 0) menu.classList.add("up");
  });
}

function closeAllDropdowns() {
  qsa(".dropdown").forEach(dropdown => dropdown.classList.remove("show", "up"));
  qsa(".action-menu-cell.menu-open").forEach(cell => cell.classList.remove("menu-open"));
  qsa("tr.menu-open").forEach(row => row.classList.remove("menu-open"));
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAllDropdowns();
    closeSharedModal();
    closeViewModal();
    closeFloatingMenus();
  }
});

function statusBadge(status) {
  const normalized = normalizedStatus(status);
  const key = normalized.toLowerCase();
  let cls = "status-confirmed";

  if (key === "waiting" || key === "pending") cls = "status-waiting";
  else if (key === "confirmed" || key === "approved") cls = "status-confirmed";
  else if (key === "in progress") cls = "status-progress";
  else if (key === "completed") cls = "status-completed";
  else if (key === "cancelled") cls = "status-cancelled";
  else if (key === "rejected") cls = "status-rejected";

  return `<span class="status-pill ${cls}">${escapeHtml(normalized)}</span>`;
}

function paymentBadge(status) {
  const key = String(status).toLowerCase();
  let cls = "payment-unpaid";

  if (key === "paid") cls = "payment-paid";
  else if (key === "partial") cls = "payment-partial";

  return `<span class="payment-pill ${cls}">${escapeHtml(status)}</span>`;
}

function formatMoney(value) {
  return "₱" + Number(value || 0).toLocaleString();
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function formatTime(timeStr) {
  if (!timeStr) return "";
  const [h, m] = timeStr.split(":");
  const hour = Number(h);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${m} ${suffix}`;
}

function dateTimeValue(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr || "00:00"}`).getTime();
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nextDateISO(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function showToast(message, type = "info") {
  const wrap = qs("#toastWrap");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  wrap.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 220);
  }, 2600);
}
