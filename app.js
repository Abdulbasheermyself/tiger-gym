const socket = io();

const GYM_QUOTES = [
  "The only bad workout is the one that didn't happen.",
  "Discipline is choosing between what you want now and what you want most.",
  "Strength doesn't come from what you can do. It comes from overcoming what you thought you couldn't.",
  "Your body can stand almost anything. It's your mind you have to convince.",
  "Sweat is just fat crying.",
  "Progress, not perfection.",
  "Every rep counts. Every day matters."
];

const state = {
  bootstrap: null
};

const elements = {};
const MODAL_PARTIALS = [
  "member-modal",
  "payment-modal",
  "device-modal",
  "swipe-modal",
  "expense-modal",
  "class-modal",
  "book-class-modal",
  "staff-modal",
  "map-biometric-modal",
  "approve-modal",
  "reject-modal"
];

let navLinks = [];
let pages = [];
let toastRoot = null;
let pageTitle = null;

let currentStaff = null;

// Runs independently of init()/loadModalMarkup() so a problem loading modal
// partials (or anything else during startup) can never leave this stuck on
// its static "Loading…" placeholder.
renderRegistrationQr();

init().catch((error) => {
  console.error("Dashboard failed to initialize", error);
  showToast("Could not load dashboard", "Refresh the page and try again.");
});

async function init() {
  await loadModalMarkup();
  cacheElements();
  bindUi();

  const quoteEl = document.getElementById("hero-quote");
  if (quoteEl) {
    quoteEl.textContent = `"${GYM_QUOTES[Math.floor(Math.random() * GYM_QUOTES.length)]}"`;
  }

  socket.on("gym:update", (payload) => {
    state.bootstrap = payload;
    render();
  });

  socket.on("connect_error", (error) => {
    if (String(error.message || "").includes("unauthorized")) {
      window.location.href = "/login";
    }
  });

  await Promise.all([loadMe(), loadBootstrap(), loadAdmsHint()]);
}

async function renderRegistrationQr() {
  const container = document.getElementById("registration-qr");
  if (!container) return;

  try {
    const response = await fetch("/api/health");
    const health = await response.json();

    if (!health.lanIp) {
      container.innerHTML = '<span style="color:#333; font-size:0.75rem; padding:0 8px;">Server could not detect a LAN IP — connect this computer to Wi-Fi/Ethernet to enable this.</span>';
      return;
    }

    if (typeof QRCode === "undefined") {
      container.innerHTML = '<span style="color:#333; font-size:0.75rem; padding:0 8px;">QR library failed to load — this computer needs internet access once to fetch it (cdnjs.cloudflare.com).</span>';
      return;
    }

    const url = `http://${health.lanIp}:${health.port}/newmember`;
    container.innerHTML = "";
    new QRCode(container, { text: url, width: 130, height: 130 });
  } catch (error) {
    console.error("Registration QR failed to render", error);
    container.innerHTML = '<span style="color:#333; font-size:0.75rem; padding:0 8px;">Could not load QR code. Check the browser console for details.</span>';
  }
}

async function loadModalMarkup() {
  const root = document.getElementById("modal-root");
  if (!root) return;

  const partials = await Promise.all(MODAL_PARTIALS.map(async (name) => {
    const response = await fetch(`/modals/${name}.html`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load ${name}`);
    return response.text();
  }));

  root.innerHTML = partials.join("\n");
}

function cacheElements() {
  navLinks = [...document.querySelectorAll(".nav-link")];
  pages = [...document.querySelectorAll(".page")];
  toastRoot = document.getElementById("toast-root");
  pageTitle = document.getElementById("page-title");

  Object.assign(elements, {
    summaryGrid: document.getElementById("summary-grid"),
    accessFeed: document.getElementById("access-feed"),
    attendanceFeed: document.getElementById("attendance-feed"),
    memberGrid: document.getElementById("member-grid"),
    memberSearch: document.getElementById("member-search"),
    accessLog: document.getElementById("access-log"),
    deniedSummary: document.getElementById("denied-summary"),
    deviceGrid: document.getElementById("device-grid"),
    deviceEventFeed: document.getElementById("device-event-feed"),
    paymentFeed: document.getElementById("payment-feed"),
    planFeed: document.getElementById("plan-feed"),
    workoutBoard: document.getElementById("workout-board"),
    doorMode: document.getElementById("door-mode"),
    doorModeCopy: document.getElementById("door-mode-copy"),
    memberPlanSelect: document.getElementById("member-plan-select"),
    memberCoachSelect: document.getElementById("member-coach-select"),
    paymentMemberSelect: document.getElementById("payment-member-select"),
    swipeDeviceSelect: document.getElementById("swipe-device-select"),
    admsHostHint: document.getElementById("adms-host-hint"),
    admsPortHint: document.getElementById("adms-port-hint"),
    unmatchedList: document.getElementById("unmatched-list"),
    expenseList: document.getElementById("expense-list"),
    classGrid: document.getElementById("class-grid"),
    staffList: document.getElementById("staff-list"),
    staffName: document.getElementById("staff-name"),
    staffRole: document.getElementById("staff-role"),
    staffPermissionGrid: document.getElementById("staff-permission-grid"),
    bookMemberSelect: document.getElementById("book-member-select"),
    mapMemberSelect: document.getElementById("map-member-select"),
    approvalList: document.getElementById("approval-list"),
    approvalBadge: document.getElementById("approval-badge"),
    approveCoachSelect: document.getElementById("approve-coach-select")
  });
}

async function loadMe() {
  try {
    const response = await fetch("/api/me");
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    currentStaff = await response.json();
    elements.staffName.textContent = currentStaff.name;
    elements.staffRole.textContent = currentStaff.role === "owner" ? "Owner · full access" : `Operator · ${currentStaff.permissions.length} permission(s)`;
    applyPermissionVisibility();
  } catch (error) {
    window.location.href = "/login";
  }
}

function can(key) {
  return !!currentStaff && (currentStaff.role === "owner" || currentStaff.permissions.includes(key));
}

function applyPermissionVisibility() {
  toggleEl("open-member-modal", can("member_management"));
  toggleEl("open-payment-modal", can("billing_management"));
  toggleEl("open-swipe-modal", can("mark_attendance_manually"));
  toggleEl("open-device-modal", can("attendance_access"));
  toggleEl("open-expense-modal", can("expense_management"));
  toggleEl("open-class-modal", can("group_class_management"));
  toggleEl("open-staff-modal", can("staff_management"));
}
function toggleEl(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? "" : "none";
}

function bindUi() {
  navLinks.forEach((link) => {
    link.addEventListener("click", () => activatePage(link.dataset.page, link.textContent));
  });

  document.querySelectorAll("dialog.modal").forEach((dialog) => {
    dialog.addEventListener("close", () => {
      document.body.style.overflow = "";
    });
  });

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
  });

  document.getElementById("open-member-modal")?.addEventListener("click", () => openDialog("member-modal"));
  document.getElementById("open-payment-modal")?.addEventListener("click", () => openDialog("payment-modal"));
  document.getElementById("open-swipe-modal")?.addEventListener("click", () => openDialog("swipe-modal"));
  document.getElementById("open-device-modal")?.addEventListener("click", () => openDialog("device-modal"));
  document.getElementById("open-expense-modal")?.addEventListener("click", () => openDialog("expense-modal"));
  document.getElementById("open-class-modal")?.addEventListener("click", () => openDialog("class-modal"));
  document.getElementById("open-staff-modal")?.addEventListener("click", () => openStaffModal());

  document.getElementById("member-form")?.addEventListener("submit", handleMemberSubmit);
  document.getElementById("payment-form")?.addEventListener("submit", handlePaymentSubmit);
  document.getElementById("swipe-form")?.addEventListener("submit", handleSwipeSubmit);
  document.getElementById("device-form")?.addEventListener("submit", handleDeviceSubmit);
  document.getElementById("expense-form")?.addEventListener("submit", handleExpenseSubmit);
  document.getElementById("class-form")?.addEventListener("submit", handleClassSubmit);
  document.getElementById("book-class-form")?.addEventListener("submit", handleBookClassSubmit);
  document.getElementById("staff-form")?.addEventListener("submit", handleStaffSubmit);
  document.getElementById("map-biometric-form")?.addEventListener("submit", handleMapBiometricSubmit);
  document.getElementById("approve-form")?.addEventListener("submit", handleApproveSubmit);
  document.getElementById("reject-form")?.addEventListener("submit", handleRejectSubmit);
  document.getElementById("logout-btn")?.addEventListener("click", handleLogout);
  elements.memberSearch?.addEventListener("input", renderMembers);
}

async function handleLogout() {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
}

async function loadAdmsHint() {
  elements.admsHostHint.textContent = window.location.hostname;
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    elements.admsPortHint.textContent = data.port || window.location.port || "80";
  } catch (error) {
    elements.admsPortHint.textContent = window.location.port || "80";
  }
}

async function loadBootstrap() {
  try {
    const response = await fetch("/api/bootstrap");
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) throw new Error("Bootstrap request failed");
    state.bootstrap = await response.json();
    render();
  } catch (error) {
    showToast("Could not load dashboard", "The server did not return dashboard data.");
  }
}

function activatePage(pageId, label) {
  navLinks.forEach((link) => link.classList.toggle("active", link.dataset.page === pageId));
  pages.forEach((page) => page.classList.toggle("active", page.id === pageId));
  pageTitle.textContent = label;
}

function render() {
  const data = state.bootstrap;
  if (!data) return;

  elements.doorMode.textContent = capitalize(data.door.mode);
  elements.doorModeCopy.textContent = data.door.webhookConfigured
    ? "Webhook target configured for door actions."
    : "No physical door relay active.";

  fillSelect(elements.memberPlanSelect, data.plans, (item) => ({ value: item.id, label: `${item.name} · ₹${Number(item.price).toLocaleString("en-IN")}` }), "No plans available");
  fillSelect(elements.memberCoachSelect, data.coaches, (item) => ({ value: item.id, label: item.name }), "No coaches available");
  fillSelect(elements.paymentMemberSelect, data.members, (item) => ({ value: item.id, label: item.full_name }), "No members available");
  fillSelect(elements.swipeDeviceSelect, data.devices, (item) => ({ value: item.serial, label: `${item.label} (${item.serial})` }), "No devices available");
  fillSelect(elements.bookMemberSelect, data.members, (item) => ({ value: item.id, label: item.full_name }), "No members available");
  fillSelect(elements.mapMemberSelect, data.members, (item) => ({ value: item.id, label: `${item.full_name} (${item.biometric_id})` }), "No members available");
  fillSelect(elements.approveCoachSelect, data.coaches, (item) => ({ value: item.id, label: item.name }), "No coaches available");

  renderSummary(data.summary);
  renderAccessFeed(data.accessLogs.slice(0, 8), elements.accessFeed);
  renderAttendanceFeed(data.attendance.slice(0, 8), elements.attendanceFeed);
  renderMembers();
  renderAccessFeed(data.accessLogs, elements.accessLog);
  renderDeniedSummary(data.accessLogs);
  renderDevices(data.devices);
  renderDeviceEvents(data.deviceEvents);
  renderUnmatchedSwipes(data.unmatchedSwipes);
  renderPayments(data.payments);
  renderPlans(data.plans);
  renderWorkouts(data.workouts);
  renderExpenses(data.expenses);
  renderClasses(data.classes);
  renderStaffList(data.staff);
  renderStaffPermissionGrid(data.permissionKeys);
  renderApprovals(data.membershipRequests, data.pendingApprovals);
}

function renderSummary(summary) {
  const cards = [
    ["Active members", summary.activeMembers, "Members with current access"],
    ["Renewals due", summary.renewalsDue, "Expiring in the next 7 days"],
    ["Today's check-ins", summary.todayCheckins, "Attendance rows stored from swipes"],
    ["Month revenue", `₹${Number(summary.monthRevenue).toLocaleString("en-IN")}`, "Collections stored in database"],
    ["Month expenses", `₹${Number(summary.monthExpenses).toLocaleString("en-IN")}`, "Running costs logged this month"],
    ["Granted today", summary.grantedToday, "Door approvals"],
    ["Denied today", summary.deniedToday, "Blocked attempts"]
  ];

  elements.summaryGrid.innerHTML = cards.map(([label, value, note]) => `
    <article class="summary-card">
      <p class="card-label">${label}</p>
      <strong>${value}</strong>
      <p>${note}</p>
    </article>
  `).join("");
}

function renderMembers() {
  const query = elements.memberSearch.value.trim().toLowerCase();
  const members = state.bootstrap.members.filter((member) => {
    return [
      member.full_name,
      member.phone,
      member.biometric_id,
      member.goal,
      member.plan_name,
      member.coach_name
    ].join(" ").toLowerCase().includes(query);
  });

  if (!members.length) {
    elements.memberGrid.innerHTML = `<div class="list-row"><div><strong>No members found</strong><p>Try a different search or add a new member.</p></div></div>`;
    return;
  }

  elements.memberGrid.innerHTML = members.map((member) => `
    <article class="member-card">
      <div class="list-row">
        <div>
          <p class="card-label">Biometric ID</p>
          <h4>${member.full_name}</h4>
          <p>${member.biometric_id} · ${member.phone}</p>
        </div>
        <span class="status-pill ${member.status === "active" ? "" : "warning"}">${member.status}</span>
      </div>
      <div class="tag-row">
        <span class="tag">${member.plan_name || "Plan not assigned"}</span>
        <span class="tag">${member.coach_name || "Coach not assigned"}</span>
        <span class="tag">${member.goal}</span>
      </div>
      <div>
        <p>Expiry: ${formatDate(member.expires_at)}</p>
        <p>Emergency: ${member.emergency_contact}</p>
        <p>Access: ${member.access_enabled ? "Enabled" : "Disabled"}</p>
      </div>
    </article>
  `).join("");
}

function renderAccessFeed(items, target) {
  target.innerHTML = items.map((item) => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-item-content">
        <strong>${item.full_name || "Unknown member"}</strong>
        <p>${item.granted ? "Granted" : "Denied"} · ${item.reason}</p>
        <p>${item.door_action} · ${item.device_serial}</p>
      </div>
      <span class="timeline-time">${formatDateTime(item.event_time)}</span>
    </div>
  `).join("");
}

function renderAttendanceFeed(items, target) {
  target.innerHTML = items.map((item) => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-item-content">
        <strong>${item.full_name}</strong>
        <p>${item.source} · ${item.result}</p>
        <p>${item.device_serial} · ${item.biometric_id}</p>
      </div>
      <span class="timeline-time">${formatDateTime(item.event_time)}</span>
    </div>
  `).join("");
}

function renderDeniedSummary(accessLogs) {
  const denied = accessLogs.filter((item) => !item.granted);
  const grouped = denied.reduce((acc, item) => {
    acc[item.reason] ||= 0;
    acc[item.reason] += 1;
    return acc;
  }, {});

  const rows = Object.entries(grouped);
  elements.deniedSummary.innerHTML = rows.length
    ? rows.map(([reason, count]) => `
        <div class="list-row">
          <div>
            <strong>${reason}</strong>
            <p>Intervention suggested</p>
          </div>
          <span class="status-pill danger">${count}</span>
        </div>
      `).join("")
    : `<div class="list-row"><div><strong>No denied attempts</strong><p>Access is clean today.</p></div></div>`;
}

function renderDevices(devices) {
  elements.deviceGrid.innerHTML = devices.map((device) => `
    <article class="device-card">
      <div class="list-row">
        <div>
          <p class="card-label">${device.model}</p>
          <h4>${device.label}</h4>
          <p>${device.serial}</p>
        </div>
        <span class="status-pill ${device.health === "online" ? "" : "warning"}">${device.health}</span>
      </div>
      <div class="tag-row">
        <span class="tag">${device.ip_address}</span>
        <span class="tag">${device.adms_host}:${device.adms_port}</span>
        <span class="tag">${device.algorithm}</span>
      </div>
      <div>
        <p>MAC: ${device.mac_address || "Not set"}</p>
        <p>Proxy: ${device.proxy_server} · Last seen: ${device.last_seen_at ? formatDateTime(device.last_seen_at) : "Not yet"}</p>
      </div>
      <div class="tag-row">
        <button class="ghost-btn" data-health-check="${device.serial}">Run Health Check</button>
        <button class="ghost-btn danger-btn" data-delete-device="${device.serial}">Remove</button>
      </div>
    </article>
  `).join("");

  document.querySelectorAll("[data-health-check]").forEach((button) => {
    button.addEventListener("click", async () => {
      await fetch(`/api/devices/${button.dataset.healthCheck}/health-check`, { method: "POST" });
      showToast("Device refreshed", "Health check event stored and device state updated.");
    });
  });

  document.querySelectorAll("[data-delete-device]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Remove this device? Real swipes from it will auto-register it again.")) return;
      await fetch(`/api/devices/${button.dataset.deleteDevice}`, { method: "DELETE" });
      showToast("Device removed", "It will reappear automatically if it contacts the server again.");
    });
  });
}

async function handleDeviceSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const response = await fetch("/api/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Device not saved", result.error || "Unknown error");
    return;
  }
  form.reset();
  document.getElementById("device-modal").close();
  showToast("Device registered", "It will start showing live swipes as soon as it checks in.");
}

function renderDeviceEvents(events) {
  elements.deviceEventFeed.innerHTML = events.map((event) => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-item-content">
        <strong>${event.title}</strong>
        <p>${event.detail}</p>
        <p>${event.device_serial} · ${event.severity}</p>
      </div>
      <span class="timeline-time">${formatDateTime(event.event_time)}</span>
    </div>
  `).join("");
}

function renderPayments(payments) {
  elements.paymentFeed.innerHTML = payments.length ? payments.map((payment) => `
    <div class="list-row">
      <div>
        <strong>${payment.full_name}</strong>
        <p>${payment.notes || "Payment captured"}</p>
      </div>
      <div>
        <strong>₹${Number(payment.amount).toLocaleString("en-IN")}</strong>
        <p>${payment.method} · ${formatDate(payment.paid_at)}</p>
      </div>
    </div>
  `).join("") : `<div class="list-row"><div><strong>No payments yet</strong><p>Collections will appear here once recorded.</p></div></div>`;
}

function renderPlans(plans) {
  elements.planFeed.innerHTML = plans.length ? plans.map((plan) => `
    <div class="list-row">
      <div>
        <strong>${plan.name}</strong>
        <p>${plan.category} · ${plan.duration_days} days</p>
      </div>
      <strong>₹${Number(plan.price).toLocaleString("en-IN")}</strong>
    </div>
  `).join("") : `<div class="list-row"><div><strong>No plans available</strong><p>Add or seed plans to show memberships here.</p></div></div>`;
}

function renderWorkouts(workouts) {
  elements.workoutBoard.innerHTML = workouts.length ? workouts.map((workout) => `
    <article class="workout-card">
      <div>
        <p class="card-label">${workout.audience}</p>
        <h4>${workout.title}</h4>
        <p>${workout.schedule}</p>
      </div>
      <div class="tag-row">
        ${workout.blocks.map((block) => `<span class="tag">${block}</span>`).join("")}
      </div>
    </article>
  `).join("") : `<div class="list-row"><div><strong>No workouts published</strong><p>Workout blocks will appear here.</p></div></div>`;
}

async function handleMemberSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const response = await fetch("/api/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    showToast(
      result.error === "Member already exist." ? "Member already exist" : "Member not saved",
      result.detail || result.error || "Unknown error"
    );
    return;
  }
  form.reset();
  document.getElementById("member-modal").close();
  showToast("Member added", "The roster and access list have been updated.");
}

async function handlePaymentSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const response = await fetch("/api/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Payment not saved", result.error || "Unknown error");
    return;
  }
  form.reset();
  document.getElementById("payment-modal").close();
  showToast("Payment saved", "Collections and dashboard metrics refreshed.");
}

async function handleSwipeSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const response = await fetch("/api/simulate-swipe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Swipe failed", result.error || "Unknown error");
    return;
  }
  form.reset();
  document.getElementById("swipe-modal").close();
  showToast(
    result.result.granted ? "Access granted" : "Access denied",
    result.result.granted
      ? `${result.result.member.fullName} was authorized. ${result.result.doorAction}.`
      : result.result.reason
  );
}

function fillSelect(select, items, mapper, emptyLabel = "No options available") {
  if (!select) return;

  const safeItems = Array.isArray(items) ? items : [];
  if (!safeItems.length) {
    select.disabled = true;
    select.innerHTML = `<option value="">${emptyLabel}</option>`;
    return;
  }

  select.disabled = false;
  select.innerHTML = safeItems.map((item) => {
    const option = mapper(item);
    return `<option value="${option.value}">${option.label}</option>`;
  }).join("");
}

function openDialog(id) {
  document.body.style.overflow = "hidden";
  document.getElementById(id).showModal();
}

function showToast(title, message) {
  if (!toastRoot) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<strong>${title}</strong><span>${message}</span>`;
  toastRoot.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function formatDate(value) {
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function formatDateTime(value) {
  return new Date(value).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ============================================================================
// Unmatched biometric swipes -> map to member
// ============================================================================

function renderUnmatchedSwipes(items) {
  elements.unmatchedList.innerHTML = items.length
    ? items.map((item) => `
        <div class="list-row">
          <div>
            <strong>PIN ${item.biometric_id}</strong>
            <p>${item.attempts} attempt(s) · last seen ${formatDateTime(item.last_seen)} · ${item.device_serial}</p>
          </div>
          ${can("member_management") ? `<button class="ghost-btn" data-map-pin="${item.biometric_id}">Map to Member</button>` : ""}
        </div>
      `).join("")
    : `<div class="list-row"><div><strong>All clear</strong><p>Every recent swipe matched a member.</p></div></div>`;

  document.querySelectorAll("[data-map-pin]").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("map-biometric-id").value = button.dataset.mapPin;
      document.getElementById("map-biometric-id-display").value = button.dataset.mapPin;
      openDialog("map-biometric-modal");
    });
  });
}

async function handleMapBiometricSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const memberId = form.memberId.value;
  const biometricId = document.getElementById("map-biometric-id").value;
  const response = await fetch(`/api/members/${memberId}/biometric`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ biometricId })
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Could not map swipe", result.error || "Unknown error");
    return;
  }
  document.getElementById("map-biometric-modal").close();
  showToast("Swipe mapped", "This PIN will now check the member in automatically.");
}

// ============================================================================
// Expenses
// ============================================================================

function renderExpenses(expenses) {
  elements.expenseList.innerHTML = expenses.length
    ? expenses.map((expense) => `
        <div class="list-row">
          <div>
            <strong>${expense.category}</strong>
            <p>${expense.description || "No description"} · added by ${expense.added_by || "—"}</p>
          </div>
          <div style="display:flex; align-items:center; gap:10px;">
            <div style="text-align:right;">
              <strong>₹${Number(expense.amount).toLocaleString("en-IN")}</strong>
              <p>${formatDate(expense.expense_date)}</p>
            </div>
            ${can("delete_access") ? `<button class="ghost-btn danger-btn" data-delete-expense="${expense.id}">Remove</button>` : ""}
          </div>
        </div>
      `).join("")
    : `<div class="list-row"><div><strong>No expenses logged</strong><p>Add your first running cost.</p></div></div>`;

  document.querySelectorAll("[data-delete-expense]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Remove this expense?")) return;
      await fetch(`/api/expenses/${button.dataset.deleteExpense}`, { method: "DELETE" });
      showToast("Expense removed", "The books have been updated.");
    });
  });
}

async function handleExpenseSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const response = await fetch("/api/expenses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Expense not saved", result.error || "Unknown error");
    return;
  }
  form.reset();
  document.getElementById("expense-modal").close();
  showToast("Expense logged", "Running costs updated.");
}

// ============================================================================
// Group classes
// ============================================================================

function renderClasses(classes) {
  elements.classGrid.innerHTML = classes.length
    ? classes.map((cls) => `
        <article class="member-card">
          <div class="list-row">
            <div>
              <p class="card-label">${cls.trainer || "No trainer assigned"}</p>
              <h4>${cls.name}</h4>
              <p>${cls.days || "No schedule set"} ${cls.start_time ? "· " + cls.start_time : ""}</p>
            </div>
            <span class="status-pill ${cls.booked_count >= cls.capacity ? "danger" : ""}">${cls.booked_count}/${cls.capacity}</span>
          </div>
          <div><p>${cls.description || ""}</p></div>
          <div class="tag-row">
            ${can("group_class_management") ? `<button class="ghost-btn" data-book-class="${cls.id}">Book Member</button>` : ""}
            ${can("delete_access") ? `<button class="ghost-btn danger-btn" data-delete-class="${cls.id}">Delete</button>` : ""}
          </div>
        </article>
      `).join("")
    : `<div class="list-row"><div><strong>No classes scheduled</strong><p>Create your first group class.</p></div></div>`;

  document.querySelectorAll("[data-book-class]").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("book-class-id").value = button.dataset.bookClass;
      openDialog("book-class-modal");
    });
  });

  document.querySelectorAll("[data-delete-class]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Delete this class? Existing bookings will be removed.")) return;
      await fetch(`/api/classes/${button.dataset.deleteClass}`, { method: "DELETE" });
      showToast("Class deleted", "The schedule has been updated.");
    });
  });
}

async function handleClassSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const response = await fetch("/api/classes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Class not saved", result.error || "Unknown error");
    return;
  }
  form.reset();
  document.getElementById("class-modal").close();
  showToast("Class scheduled", "It's now open for bookings.");
}

async function handleBookClassSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const classId = document.getElementById("book-class-id").value;
  const memberId = form.memberId.value;
  const response = await fetch(`/api/classes/${classId}/book`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId })
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Booking failed", result.error || "Unknown error");
    return;
  }
  document.getElementById("book-class-modal").close();
  showToast("Member booked", "They're on the class roster.");
}

// ============================================================================
// Membership request approvals
// ============================================================================

function renderApprovals(requests, pendingCount) {
  if (pendingCount > 0) {
    elements.approvalBadge.textContent = pendingCount;
    elements.approvalBadge.style.display = "";
  } else {
    elements.approvalBadge.style.display = "none";
  }

  if (!requests.length) {
    elements.approvalList.innerHTML = `<div class="list-row"><div><strong>No requests yet</strong><p>New sign-ups from the front-desk kiosk will show up here.</p></div></div>`;
    return;
  }

  elements.approvalList.innerHTML = requests.map((request) => `
    <div class="list-row">
      <div>
        <strong>${request.full_name}</strong>
        <p>${request.phone} ${request.email ? "· " + request.email : ""} · wants ${request.plan_name || "an unknown plan"} ${request.plan_price ? "(₹" + Number(request.plan_price).toLocaleString("en-IN") + ")" : ""}</p>
        <p>Goal: ${request.goal || "Not specified"} ${request.coach_name ? "· Prefers " + request.coach_name : ""} · Biometric ${request.biometric_id} · ${formatDateTime(request.submitted_at)}</p>
        ${request.status !== "pending" ? `<p>${capitalize(request.status)} by ${request.reviewed_by || "—"} on ${formatDateTime(request.reviewed_at)}${request.rejection_reason ? " · " + request.rejection_reason : ""}</p>` : ""}
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="status-pill ${request.status === "pending" ? "warning" : request.status === "rejected" ? "danger" : ""}">${request.status}</span>
        ${request.status === "pending" && can("approve_membership_requests") ? `
          <button class="ghost-btn" data-approve="${request.id}" data-plan-id="${request.plan_id}" data-coach-id="${request.coach_id || ""}" data-biometric-id="${request.biometric_id || ""}" data-name="${request.full_name}">Approve</button>
          <button class="ghost-btn danger-btn" data-reject="${request.id}">Reject</button>
        ` : ""}
      </div>
    </div>
  `).join("");

  document.querySelectorAll("[data-approve]").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("approve-request-id").value = button.dataset.approve;
      document.getElementById("approve-modal-name").textContent = `Create membership for ${button.dataset.name}`;
      if (button.dataset.coachId) elements.approveCoachSelect.value = button.dataset.coachId;
      document.getElementById("approve-expires-input").value = "";

      const biometricInput = document.getElementById("approve-biometric-input");
      const biometricHint = document.getElementById("approve-biometric-hint");
      if (button.dataset.biometricId) {
        biometricInput.value = button.dataset.biometricId;
        biometricInput.readOnly = true;
        biometricHint.textContent = "Captured from a device swipe. Expiry defaults to today + the requested plan's duration.";
      } else {
        biometricInput.value = "";
        biometricInput.readOnly = false;
        biometricHint.textContent = "No fingerprint scan on file yet — assign an ID for this member. Expiry defaults to today + the requested plan's duration.";
      }

      openDialog("approve-modal");
    });
  });

  document.querySelectorAll("[data-reject]").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("reject-request-id").value = button.dataset.reject;
      openDialog("reject-modal");
    });
  });
}

async function handleApproveSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const requestId = document.getElementById("approve-request-id").value;
  const payload = {
    biometricId: form.biometricId.value.trim(),
    coachId: form.coachId.value,
    expiresAt: form.expiresAt.value || undefined
  };
  const response = await fetch(`/api/membership-requests/${requestId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Could not approve", result.error || "Unknown error");
    return;
  }
  document.getElementById("approve-modal").close();
  showToast("Member created", "They can now scan in and their swipe will grant access.");
}

async function handleRejectSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const requestId = document.getElementById("reject-request-id").value;
  const response = await fetch(`/api/membership-requests/${requestId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: form.reason.value })
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Could not reject", result.error || "Unknown error");
    return;
  }
  document.getElementById("reject-modal").close();
  showToast("Request rejected", "The applicant was not added as a member.");
}

function renderStaffPermissionGrid(permissionKeys, checkedKeys = []) {
  if (!permissionKeys) return;
  elements.staffPermissionGrid.innerHTML = permissionKeys.map((perm) => `
    <label class="perm-item">
      <input type="checkbox" value="${perm.key}" class="staff-perm-checkbox" ${checkedKeys.includes(perm.key) ? "checked" : ""}>
      ${perm.label} ${perm.important ? '<span class="imp-tag">IMP</span>' : ""}
    </label>
  `).join("");
}

function openStaffModal() {
  document.getElementById("staff-form").reset();
  if (state.bootstrap) renderStaffPermissionGrid(state.bootstrap.permissionKeys, []);
  openDialog("staff-modal");
}

function renderStaffList(staffMembers) {
  if (!staffMembers.length) {
    elements.staffList.innerHTML = `<div class="list-row"><div><strong>No staff accounts yet</strong><p>Create an operator login to delegate access.</p></div></div>`;
    return;
  }

  elements.staffList.innerHTML = staffMembers.map((member) => `
    <div class="list-row">
      <div>
        <strong>${member.name}</strong>
        <p>${member.email} · ${member.role === "owner" ? "Owner (full access)" : `${member.permissions.length} permission(s)`}</p>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="status-pill ${member.active ? "" : "warning"}">${member.active ? "active" : "disabled"}</span>
        ${member.role !== "owner" && can("delete_access") ? `<button class="ghost-btn danger-btn" data-delete-staff="${member.id}">Remove</button>` : ""}
      </div>
    </div>
  `).join("");

  document.querySelectorAll("[data-delete-staff]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Remove this staff login?")) return;
      const response = await fetch(`/api/staff/${button.dataset.deleteStaff}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) {
        showToast("Could not remove", result.error || "Unknown error");
        return;
      }
      showToast("Staff removed", "Their login no longer works.");
    });
  });
}

async function handleStaffSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.permissions = [...document.querySelectorAll(".staff-perm-checkbox:checked")].map((cb) => cb.value);
  const response = await fetch("/api/staff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Operator not saved", result.error || "Unknown error");
    return;
  }
  form.reset();
  document.getElementById("staff-modal").close();
  showToast("Operator added", "They can now log in with the permissions you granted.");
}