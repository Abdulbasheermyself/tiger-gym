const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const http = require("http");
const express = require("express");
const initSqlJs = require("sql.js");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 5000);
const DATA_FILE = path.join(__dirname, "data", "tiger_gym.db");
const DOOR_TRIGGER_MODE = String(process.env.DOOR_TRIGGER_MODE || "simulation").toLowerCase();
const DOOR_TRIGGER_URL = process.env.DOOR_TRIGGER_URL || "";
const ACCESS_WEBHOOK_SECRET = process.env.ACCESS_WEBHOOK_SECRET || "";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ============================================================================
// Lightweight auth: no new dependencies (no express-session/bcrypt) to stay
// consistent with this project's minimal dependency footprint. Sessions live
// in memory (fine for a single-process local server, same pattern the app
// already uses for the sql.js database itself); passwords are hashed with
// Node's built-in scrypt.
// ============================================================================
const SESSION_COOKIE = "tg_session";
const sessions = new Map(); // token -> { staffId, expiresAt }
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const idx = part.indexOf("=");
      return [decodeURIComponent(part.slice(0, idx)), decodeURIComponent(part.slice(idx + 1))];
    })
  );
}

function createSession(staffId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { staffId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function getStaffFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const staff = dbGet("SELECT * FROM staff WHERE id = ? AND active = 1", [session.staffId]);
  return staff || null;
}

function staffPermissions(staff) {
  if (!staff) return [];
  if (staff.role === "owner") return PERMISSION_KEYS.map((p) => p.key);
  try {
    return JSON.parse(staff.permissions || "[]");
  } catch (error) {
    return [];
  }
}

function hasPermission(staff, key) {
  return staffPermissions(staff).includes(key);
}

function requireAuth(req, res, next) {
  const staff = getStaffFromRequest(req);
  if (!staff) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  req.staff = staff;
  next();
}

function requirePermission(key) {
  return (req, res, next) => {
    const staff = req.staff || getStaffFromRequest(req);
    if (!staff) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }
    if (!hasPermission(staff, key)) {
      res.status(403).json({ error: "You do not have permission for this action" });
      return;
    }
    req.staff = staff;
    next();
  };
}

const PERMISSION_KEYS = [
  { key: "member_management", label: "Member Management", important: false },
  { key: "billing_management", label: "Billing / Payments", important: false },
  { key: "attendance_access", label: "Attendance & Devices", important: false },
  { key: "staff_management", label: "Staff Management", important: false },
  { key: "expense_management", label: "Expense Management", important: false },
  { key: "group_class_management", label: "Group Class Management", important: false },
  { key: "approve_membership_requests", label: "Approve New Member Requests", important: true },
  { key: "mark_attendance_manually", label: "Simulate / Mark Attendance Manually", important: true },
  { key: "delete_access", label: "Delete Access", important: true }
];

app.use(express.json({ limit: "2mb" }));
// ZKTeco devices push attendance as raw tab-separated text (not JSON), so the
// /iclock/* routes below need the raw body instead of the JSON parser.
app.use("/iclock", express.text({ type: () => true, limit: "5mb" }));

app.get("/", (req, res) => {
  const staff = getStaffFromRequest(req);
  if (!staff) {
    res.redirect("/login");
    return;
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
  const staff = getStaffFromRequest(req);
  if (staff) {
    res.redirect("/");
    return;
  }
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const staff = dbGet("SELECT * FROM staff WHERE lower(email) = ? AND active = 1", [String(email || "").trim().toLowerCase()]);
  if (!staff || !verifyPassword(password || "", staff.password_hash)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const token = createSession(staff.id);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
  res.json({ ok: true, staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role } });
});

app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE]) destroySession(cookies[SESSION_COOKIE]);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const staff = getStaffFromRequest(req);
  if (!staff) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  res.json({
    id: staff.id, name: staff.name, email: staff.email, role: staff.role,
    permissions: staffPermissions(staff)
  });
});

// ============================================================================
// Public front-desk kiosk (no login) -- a new person scans their fingerprint
// on the reader (enrolled on the device with no member record yet), the
// welcome page picks that up in real time over the /kiosk socket namespace,
// and lets them submit a membership request for a manager to approve.
// ============================================================================

app.get("/welcome", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "welcome.html"));
});

app.get("/api/public/plans", (_req, res) => {
  res.json(dbAll("SELECT id, name, duration_days, price, category FROM plans ORDER BY price ASC"));
});

app.get("/api/public/coaches", (_req, res) => {
  res.json(dbAll("SELECT id, name, specialty FROM coaches ORDER BY name ASC"));
});

app.post("/api/public/membership-requests", (req, res) => {
  const { biometricId, fullName, phone, email, goal, planId, coachId } = req.body || {};
  if (!biometricId || !fullName || !phone || !planId) {
    res.status(400).json({ error: "biometricId, fullName, phone, and planId are required" });
    return;
  }

  const duplicate = findDuplicateMember({ phone, biometricId });
  if (duplicate) {
    res.status(409).json({
      error: duplicate.field === "phone"
        ? "Looks like you're already a member! Please check in at the front desk instead."
        : duplicate.error
    });
    return;
  }

  const existingPending = dbGet(
    "SELECT id FROM membership_requests WHERE status = 'pending' AND (biometric_id = ? OR phone = ?)",
    [biometricId, phone]
  );
  if (existingPending) {
    res.json({ ok: true, alreadyPending: true, message: "Your request is already waiting for manager approval." });
    return;
  }

  dbRun(
    `INSERT INTO membership_requests
      (biometric_id, device_serial, full_name, phone, email, goal, plan_id, coach_id, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [biometricId, req.body.deviceSerial || "", fullName, phone, email || "", goal || "", Number(planId), coachId ? Number(coachId) : null, nowIso()]
  );
  persistDb();
  emitRefresh();
  res.json({ ok: true, message: "Thanks! Your request has been sent to the gym manager for approval." });
});

app.use(express.static(path.join(__dirname, "public")));

let db;

const seed = {
  plans: [
    ["Lean Start", 30, 2499, "General Fitness"],
    ["Forge Strength", 84, 6999, "Strength"],
    ["Mass Protocol", 90, 8499, "Transformation"],
    ["Move & Restore", 56, 5299, "Mobility"],
    ["Athlete Prime", 42, 9999, "Personal Training"]
  ],
  coaches: [
    ["Coach Varun", "Strength & athletic prep", 22, 8, "High load"],
    ["Coach Hiba", "Women's fitness & rehab", 17, 6, "Open slots after 6pm"],
    ["Coach Karthik", "Hypertrophy & nutrition", 14, 4, "Available"]
  ],
  members: [
    ["Aarav Menon", "9876543210", "Meera Menon - 9845012345", "Strength Rebuild", 2, 1, "TG-1001", 1, "active", -60, 6],
    ["Sana Fathima", "9886011199", "Imran - 9886007788", "Postpartum Fat Loss", 1, 2, "TG-1002", 1, "active", -46, 3],
    ["Rohit Nayak", "9845111122", "Swetha Nayak - 9845100088", "Muscle Gain", 3, 3, "TG-1003", 1, "active", -100, 16],
    ["Divya Krishnan", "9810012345", "Harish - 9810098989", "PCOS Mobility", 4, 2, "TG-1004", 1, "active", -127, 2],
    ["Pranav Shetty", "9822334455", "Latha Shetty - 9822300001", "Athletic Conditioning", 5, 1, "TG-1005", 1, "active", -16, 75]
  ],
  payments: [
    [3, 8499, "UPI", "Mass Protocol renewal", -3],
    [1, 6999, "Card", "Forge Strength package", -7],
    [5, 9999, "Bank Transfer", "Athlete Prime onboarding", -10],
    [2, 2499, "Cash", "Lean Start monthly plan", -16]
  ],
  attendance: [
    [1, "6583154400429", "TG-1001", "biometric", "granted", 0, 6, 4],
    [3, "6583154400429", "TG-1003", "biometric", "granted", 0, 6, 28],
    [5, "6583154400429", "TG-1005", "biometric", "granted", 0, 7, 10],
    [2, "6583154400429", "TG-1002", "manual", "granted", 0, 18, 42],
    [4, "6583154400429", "TG-1004", "biometric", "granted", -1, 19, 1]
  ],
  devices: [
    [
      "6583154400429",
      "Tiger Gate Reader",
      "X200",
      "Finger VX10.0",
      "Ver 6.81 (build 367)",
      "00:17:61:10:1b:16",
      "192.168.1.201",
      "255.255.255.0",
      "192.168.1.1",
      "Auto",
      "20.244.9.194",
      80,
      "IP mode",
      "OFF",
      "online",
      null
    ],
    [
      "6583154400429-B",
      "Tiger Gate Reader Backup Route",
      "X200",
      "Finger VX10.0",
      "Ver 6.81 (build 367)",
      "00:17:61:10:1b:16",
      "192.168.1.201",
      "255.255.255.0",
      "192.168.1.1",
      "Auto",
      "13.127.100.164",
      81,
      "IP mode",
      "OFF",
      "standby",
      null
    ]
  ],
  deviceEvents: [
    ["6583154400429", "heartbeat", "Heartbeat accepted", "X200 posted events to the current ADMS endpoint.", "info", 0, 6, 0],
    ["6583154400429", "clock_warning", "Time drift warning", "Device clock differs from dashboard by 7 minutes.", "warning", 0, 6, 1],
    ["6583154400429", "network_retry", "Network retry", "Primary route switched from desk LAN to backup switch port.", "warning", -1, 21, 30]
  ],
  workouts: [
    ["Upper Power Ladder", "Strength members", "Mon / Thu", "Bench 5x5 | Weighted row 4x8 | Cable finisher"],
    ["Glute Recovery Flow", "Women's mobility", "Tue / Sat", "Band walks | Hip thrust tempo | Breathing cooldown"],
    ["Athlete Engine Circuit", "Performance clients", "Wed / Fri", "Sled push intervals | Battle ropes | Contrast jumps"]
  ]
};

function isoDateFromOffset(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function isoDateTime(days, hours, minutes) {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function persistDb() {
  fs.writeFileSync(DATA_FILE, Buffer.from(db.export()));
}

function dbRun(sql, params = []) {
  db.run(sql, params);
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(sql, params = []) {
  return dbAll(sql, params)[0] || null;
}

/**
 * Duplicate-entry guard for member creation. Checks two independent things,
 * not just "does this exact biometric ID already exist":
 *  - biometricId: the fingerprint is already linked to someone (DB-enforced
 *    as UNIQUE too, but this gives a friendly message instead of a raw
 *    constraint-violation error)
 *  - phone: an ACTIVE member already has this phone number, which is the
 *    much more common real-world duplicate -- someone signing up twice (at
 *    the kiosk, or being re-entered by a different staff member) usually
 *    re-enrolls a fresh fingerprint, so biometric_id alone won't catch it.
 * Expired/inactive members with the same phone are allowed through --
 * that's a legitimate returning member, not a duplicate.
 */
function findDuplicateMember({ phone, biometricId, excludeMemberId } = {}) {
  if (biometricId) {
    const existing = dbGet("SELECT id, full_name, status FROM members WHERE biometric_id = ?", [biometricId]);
    if (existing && existing.id !== excludeMemberId) {
      return {
        error: `This fingerprint is already registered to ${existing.full_name}.`,
        field: "biometricId",
        existingMemberId: existing.id
      };
    }
  }
  if (phone) {
    const existing = dbGet(
      "SELECT id, full_name, status FROM members WHERE phone = ? AND status = 'active'", [phone]
    );
    if (existing && existing.id !== excludeMemberId) {
      return {
        error: `An active member with this phone number already exists: ${existing.full_name}.`,
        field: "phone",
        existingMemberId: existing.id
      };
    }
  }
  return null;
}

function emitRefresh() {
  io.emit("gym:update", buildBootstrap());
}

function ensureSchema() {
  const schemaStatements = [
    `CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration_days INTEGER NOT NULL,
      price INTEGER NOT NULL,
      category TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS coaches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      specialty TEXT NOT NULL,
      active_clients INTEGER NOT NULL DEFAULT 0,
      sessions_today INTEGER NOT NULL DEFAULT 0,
      availability TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      emergency_contact TEXT NOT NULL,
      goal TEXT NOT NULL,
      plan_id INTEGER NOT NULL,
      coach_id INTEGER NOT NULL,
      biometric_id TEXT NOT NULL UNIQUE,
      access_enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      join_date TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES plans(id),
      FOREIGN KEY (coach_id) REFERENCES coaches(id)
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      method TEXT NOT NULL,
      notes TEXT,
      paid_at TEXT NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id)
    )`,
    `CREATE TABLE IF NOT EXISTS devices (
      serial TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      model TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      firmware TEXT NOT NULL,
      mac_address TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      subnet_mask TEXT NOT NULL,
      gateway TEXT NOT NULL,
      net_speed TEXT NOT NULL,
      adms_host TEXT NOT NULL,
      adms_port INTEGER NOT NULL,
      adms_mode TEXT NOT NULL,
      proxy_server TEXT NOT NULL,
      health TEXT NOT NULL,
      last_seen_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS attendance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      device_serial TEXT NOT NULL,
      biometric_id TEXT NOT NULL,
      source TEXT NOT NULL,
      result TEXT NOT NULL,
      event_time TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id)
    )`,
    `CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER,
      device_serial TEXT NOT NULL,
      biometric_id TEXT NOT NULL,
      granted INTEGER NOT NULL,
      reason TEXT NOT NULL,
      door_action TEXT NOT NULL,
      door_detail TEXT NOT NULL,
      source TEXT NOT NULL,
      event_time TEXT NOT NULL,
      raw_payload TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS device_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_serial TEXT NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      severity TEXT NOT NULL,
      event_time TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS workouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      audience TEXT NOT NULL,
      schedule TEXT NOT NULL,
      blocks TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      permissions TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      description TEXT,
      amount INTEGER NOT NULL,
      expense_date TEXT NOT NULL,
      added_by TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trainer TEXT,
      days TEXT,
      start_time TEXT,
      capacity INTEGER NOT NULL DEFAULT 20,
      description TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS class_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      booking_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked',
      FOREIGN KEY (class_id) REFERENCES classes(id),
      FOREIGN KEY (member_id) REFERENCES members(id)
    )`,
    `CREATE TABLE IF NOT EXISTS membership_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      biometric_id TEXT NOT NULL,
      device_serial TEXT,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      goal TEXT,
      plan_id INTEGER,
      coach_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by TEXT,
      rejection_reason TEXT,
      FOREIGN KEY (plan_id) REFERENCES plans(id),
      FOREIGN KEY (coach_id) REFERENCES coaches(id)
    )`
  ];

  schemaStatements.forEach((statement) => dbRun(statement));

  if (!dbGet("SELECT id FROM plans LIMIT 1")) {
    seed.plans.forEach((row) => dbRun(
      "INSERT INTO plans (name, duration_days, price, category) VALUES (?, ?, ?, ?)",
      row
    ));
  }

  if (!dbGet("SELECT id FROM coaches LIMIT 1")) {
    seed.coaches.forEach((row) => dbRun(
      "INSERT INTO coaches (name, specialty, active_clients, sessions_today, availability) VALUES (?, ?, ?, ?, ?)",
      row
    ));
  }

  if (!dbGet("SELECT id FROM members LIMIT 1")) {
    seed.members.forEach((row) => dbRun(
      `INSERT INTO members
        (full_name, phone, emergency_contact, goal, plan_id, coach_id, biometric_id, access_enabled, status, join_date, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8],
        isoDateFromOffset(row[9]), isoDateFromOffset(row[10]), nowIso()
      ]
    ));
  }

  if (!dbGet("SELECT id FROM payments LIMIT 1")) {
    seed.payments.forEach((row) => dbRun(
      "INSERT INTO payments (member_id, amount, method, notes, paid_at) VALUES (?, ?, ?, ?, ?)",
      [row[0], row[1], row[2], row[3], isoDateFromOffset(row[4])]
    ));
  }

  if (!dbGet("SELECT serial FROM devices LIMIT 1")) {
    seed.devices.forEach((row) => dbRun(
      `INSERT INTO devices
        (serial, label, model, algorithm, firmware, mac_address, ip_address, subnet_mask, gateway, net_speed, adms_host, adms_port, adms_mode, proxy_server, health, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row
    ));
  }

  if (!dbGet("SELECT id FROM attendance_logs LIMIT 1")) {
    seed.attendance.forEach((row) => dbRun(
      `INSERT INTO attendance_logs
        (member_id, device_serial, biometric_id, source, result, event_time, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row[0], row[1], row[2], row[3], row[4], isoDateTime(row[5], row[6], row[7]), JSON.stringify({ seeded: true })]
    ));
  }

  if (!dbGet("SELECT id FROM access_logs LIMIT 1")) {
    seed.attendance.forEach((row) => dbRun(
      `INSERT INTO access_logs
        (member_id, device_serial, biometric_id, granted, reason, door_action, door_detail, source, event_time, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row[0], row[1], row[2], row[4] === "granted" ? 1 : 0, "Seeded grant",
        "simulated_unlock", "Seed data", row[3], isoDateTime(row[5], row[6], row[7]), JSON.stringify({ seeded: true })
      ]
    ));
  }

  if (!dbGet("SELECT id FROM device_events LIMIT 1")) {
    seed.deviceEvents.forEach((row) => dbRun(
      "INSERT INTO device_events (device_serial, event_type, title, detail, severity, event_time) VALUES (?, ?, ?, ?, ?, ?)",
      [row[0], row[1], row[2], row[3], row[4], isoDateTime(row[5], row[6], row[7])]
    ));
  }

  if (!dbGet("SELECT id FROM workouts LIMIT 1")) {
    seed.workouts.forEach((row) => dbRun(
      "INSERT INTO workouts (title, audience, schedule, blocks) VALUES (?, ?, ?, ?)",
      row
    ));
  }

  if (!dbGet("SELECT id FROM staff LIMIT 1")) {
    dbRun(
      "INSERT INTO staff (name, email, password_hash, role, permissions, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
      ["Owner", "owner@tigergym.local", hashPassword("owner123"), "owner", "[]", nowIso()]
    );
  }

  persistDb();
}

function buildBootstrap() {
  const members = dbAll(`
    SELECT m.id, m.full_name, m.phone, m.emergency_contact, m.goal, m.biometric_id, m.access_enabled,
           m.status, m.join_date, m.expires_at,
           p.name AS plan_name, p.price AS plan_price, p.category AS plan_category,
           c.name AS coach_name, c.specialty AS coach_specialty
    FROM members m
    JOIN plans p ON p.id = m.plan_id
    JOIN coaches c ON c.id = m.coach_id
    ORDER BY date(m.expires_at) ASC, m.full_name ASC
  `).map((row) => ({
    ...row,
    access_enabled: !!row.access_enabled
  }));

  const plans = dbAll("SELECT * FROM plans ORDER BY price ASC");
  const coaches = dbAll("SELECT * FROM coaches ORDER BY name ASC");
  const payments = dbAll(`
    SELECT p.*, m.full_name
    FROM payments p
    JOIN members m ON m.id = p.member_id
    ORDER BY date(p.paid_at) DESC, p.id DESC
  `);
  const attendance = dbAll(`
    SELECT a.*, m.full_name
    FROM attendance_logs a
    JOIN members m ON m.id = a.member_id
    ORDER BY datetime(a.event_time) DESC, a.id DESC
    LIMIT 20
  `);
  const accessLogs = dbAll(`
    SELECT al.*, m.full_name
    FROM access_logs al
    LEFT JOIN members m ON m.id = al.member_id
    ORDER BY datetime(al.event_time) DESC, al.id DESC
    LIMIT 20
  `).map((row) => ({ ...row, granted: !!row.granted }));
  const devices = dbAll("SELECT * FROM devices ORDER BY serial ASC");
  const deviceEvents = dbAll("SELECT * FROM device_events ORDER BY datetime(event_time) DESC, id DESC LIMIT 20");
  const workouts = dbAll("SELECT * FROM workouts ORDER BY id ASC").map((row) => ({
    ...row,
    blocks: row.blocks.split("|").map((item) => item.trim())
  }));
  const expenses = dbAll("SELECT * FROM expenses ORDER BY date(expense_date) DESC, id DESC LIMIT 200");
  const classes = dbAll(`
    SELECT c.*, (SELECT COUNT(*) FROM class_bookings b WHERE b.class_id = c.id AND b.status = 'booked') AS booked_count
    FROM classes c ORDER BY c.start_time ASC
  `);
  const staffList = dbAll("SELECT id, name, email, role, permissions, active, created_at FROM staff ORDER BY created_at ASC")
    .map((row) => ({ ...row, permissions: JSON.parse(row.permissions || "[]"), active: !!row.active }));
  const unmatchedSwipes = dbAll(`
    SELECT biometric_id, device_serial, COUNT(*) AS attempts, MAX(event_time) AS last_seen
    FROM access_logs WHERE member_id IS NULL
    GROUP BY biometric_id, device_serial ORDER BY last_seen DESC LIMIT 25
  `);
  const membershipRequests = dbAll(`
    SELECT mr.*, p.name AS plan_name, p.price AS plan_price, c.name AS coach_name
    FROM membership_requests mr
    LEFT JOIN plans p ON p.id = mr.plan_id
    LEFT JOIN coaches c ON c.id = mr.coach_id
    ORDER BY datetime(mr.submitted_at) DESC LIMIT 100
  `);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayIso = startOfToday.toISOString();
  const monthPrefix = startOfToday.toISOString().slice(0, 7);
  const activeMembers = members.filter((member) => member.status === "active").length;
  const renewalsDue = members.filter((member) => member.expires_at <= isoDateFromOffset(7)).length;
  const todayCheckins = attendance.filter((entry) => entry.event_time >= todayIso).length;
  const todayAccess = accessLogs.filter((entry) => entry.event_time >= todayIso);
  const monthRevenue = payments
    .filter((payment) => String(payment.paid_at).startsWith(monthPrefix))
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
  const monthExpenses = expenses
    .filter((expense) => String(expense.expense_date).startsWith(monthPrefix))
    .reduce((sum, expense) => sum + Number(expense.amount), 0);

  return {
    summary: {
      activeMembers,
      renewalsDue,
      todayCheckins,
      monthRevenue,
      monthExpenses,
      grantedToday: todayAccess.filter((entry) => entry.granted).length,
      deniedToday: todayAccess.filter((entry) => !entry.granted).length
    },
    door: {
      mode: DOOR_TRIGGER_MODE,
      webhookConfigured: !!DOOR_TRIGGER_URL
    },
    members,
    plans,
    coaches,
    payments,
    attendance,
    accessLogs,
    devices,
    deviceEvents,
    workouts,
    expenses,
    classes,
    staff: staffList,
    unmatchedSwipes,
    membershipRequests,
    pendingApprovals: membershipRequests.filter((r) => r.status === "pending").length,
    permissionKeys: PERMISSION_KEYS
  };
}

function resolveAccess(member) {
  if (!member) {
    return { granted: false, reason: "Unknown biometric ID" };
  }
  if (!member.access_enabled) {
    return { granted: false, reason: "Access disabled for this member" };
  }
  if (member.status !== "active") {
    return { granted: false, reason: `Member status is ${member.status}` };
  }
  if (member.expires_at < isoDateFromOffset(0)) {
    return { granted: false, reason: "Membership expired" };
  }
  return { granted: true, reason: "Membership active and access permitted" };
}

async function triggerDoorUnlock(accessContext) {
  if (DOOR_TRIGGER_MODE === "webhook" && DOOR_TRIGGER_URL) {
    try {
      const response = await fetch(DOOR_TRIGGER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ACCESS_WEBHOOK_SECRET ? { "x-access-secret": ACCESS_WEBHOOK_SECRET } : {})
        },
        body: JSON.stringify(accessContext)
      });
      return {
        action: response.ok ? "webhook_unlock_sent" : "webhook_unlock_failed",
        detail: `HTTP ${response.status}`
      };
    } catch (error) {
      return { action: "webhook_error", detail: error.message };
    }
  }

  return {
    action: "simulated_unlock",
    detail: "Simulation mode active; no physical relay energized."
  };
}

function storeDeviceEvent(deviceSerial, eventType, title, detail, severity = "info", eventTime = nowIso()) {
  dbRun(
    "INSERT INTO device_events (device_serial, event_type, title, detail, severity, event_time) VALUES (?, ?, ?, ?, ?, ?)",
    [deviceSerial, eventType, title, detail, severity, eventTime]
  );
}

function requestIp(req) {
  // Strip the ::ffff: IPv4-mapped-IPv6 prefix Node adds on dual-stack sockets.
  const raw = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "";
  return raw.replace(/^::ffff:/, "");
}

/**
 * Called on every contact from a physical device (handshake, attendance push,
 * command poll). Updates health/IP for a known device, or auto-registers a
 * brand-new one by its serial number so a reader starts working the moment
 * it's pointed at this server -- no manual pre-registration required.
 * IP address is refreshed from the live connection on every contact (DHCP
 * leases change); MAC address is not carried by the ADMS protocol itself, so
 * it stays whatever was entered manually (e.g. read off the device's SysInfo
 * screen) via the Devices page.
 */
function upsertDeviceContact(serial, ip) {
  const eventTime = nowIso();
  const existing = dbGet("SELECT * FROM devices WHERE serial = ?", [serial]);

  if (existing) {
    dbRun(
      "UPDATE devices SET health = 'online', last_seen_at = ?, ip_address = ? WHERE serial = ?",
      [eventTime, ip || existing.ip_address, serial]
    );
    return existing;
  }

  dbRun(
    `INSERT INTO devices
      (serial, label, model, algorithm, firmware, mac_address, ip_address, subnet_mask, gateway, net_speed, adms_host, adms_port, adms_mode, proxy_server, health, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?)`,
    [serial, `Reader ${serial}`, "ZKTeco", "", "", "", ip || "", "", "", "Auto", "", 0, "IP mode", "OFF", eventTime]
  );
  storeDeviceEvent(serial, "auto_registered", "Device auto-registered", `First contact from ${ip || "unknown IP"}; created automatically.`, "info", eventTime);
  return dbGet("SELECT * FROM devices WHERE serial = ?", [serial]);
}

async function processBiometricEvent(payload, source = "adms-push") {
  const deviceSerial = String(payload.deviceSerial || "").trim();
  const biometricId = String(payload.biometricId || payload.userCode || "").trim();
  const eventTime = payload.eventTime || nowIso();

  if (!deviceSerial) throw new Error("deviceSerial is required");
  if (!biometricId) throw new Error("biometricId is required");

  const device = dbGet("SELECT * FROM devices WHERE serial = ? LIMIT 1", [deviceSerial]);
  if (!device) throw new Error("Unknown device serial");

  dbRun("UPDATE devices SET last_seen_at = ?, health = 'online' WHERE serial = ?", [eventTime, device.serial]);

  const member = dbGet("SELECT * FROM members WHERE biometric_id = ?", [biometricId]);
  const decision = resolveAccess(member);
  const rawPayload = JSON.stringify(payload);

  let doorAction = "not_triggered";
  let doorDetail = decision.reason;

  if (decision.granted) {
    const doorResult = await triggerDoorUnlock({
      deviceSerial: device.serial,
      deviceLabel: device.label,
      biometricId,
      memberId: member.id,
      memberName: member.full_name,
      eventTime,
      reason: decision.reason
    });
    doorAction = doorResult.action;
    doorDetail = doorResult.detail;

    dbRun(
      `INSERT INTO attendance_logs
        (member_id, device_serial, biometric_id, source, result, event_time, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [member.id, device.serial, biometricId, source, "granted", eventTime, rawPayload]
    );
  }

  dbRun(
    `INSERT INTO access_logs
      (member_id, device_serial, biometric_id, granted, reason, door_action, door_detail, source, event_time, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [member ? member.id : null, device.serial, biometricId, decision.granted ? 1 : 0, decision.reason, doorAction, doorDetail, source, eventTime, rawPayload]
  );

  if (!member) {
    // Brand-new fingerprint, never seen before -- ping the front-desk kiosk so
    // it can greet them and offer self-service registration.
    notifyKiosk(biometricId, device.serial);
  }

  storeDeviceEvent(
    device.serial,
    decision.granted ? "access_granted" : "access_denied",
    decision.granted ? `Access granted for ${member.full_name}` : "Access denied",
    decision.granted
      ? `${member.full_name} verified on ${device.label}. Door action: ${doorAction}.`
      : `Biometric ${biometricId} was denied. Reason: ${decision.reason}.`,
    decision.granted ? "info" : "warning",
    eventTime
  );

  persistDb();
  emitRefresh();

  return {
    granted: decision.granted,
    reason: decision.reason,
    doorAction,
    doorDetail,
    member: member
      ? {
          id: member.id,
          fullName: member.full_name,
          biometricId: member.biometric_id
        }
      : null
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Tiger Gym Live",
    now: nowIso(),
    port: PORT,
    doorMode: DOOR_TRIGGER_MODE,
    webhookConfigured: !!DOOR_TRIGGER_URL
  });
});

app.get("/api/bootstrap", requireAuth, (_req, res) => {
  res.json(buildBootstrap());
});

app.post("/api/members", requireAuth, requirePermission("member_management"), (req, res) => {
  const { fullName, phone, emergencyContact, goal, planId, coachId, biometricId, expiresAt } = req.body || {};
  if (!fullName || !phone || !goal || !biometricId || !expiresAt) {
    res.status(400).json({ error: "fullName, phone, goal, biometricId, and expiresAt are required" });
    return;
  }

  const duplicate = findDuplicateMember({ phone, biometricId });
  if (duplicate) {
    res.status(409).json(duplicate);
    return;
  }

  try {
    dbRun(
      `INSERT INTO members
        (full_name, phone, emergency_contact, goal, plan_id, coach_id, biometric_id, access_enabled, status, join_date, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)`,
      [
        fullName,
        phone,
        emergencyContact || "Not provided",
        goal,
        Number(planId),
        Number(coachId),
        biometricId,
        isoDateFromOffset(0),
        expiresAt,
        nowIso()
      ]
    );
  } catch (error) {
    res.status(409).json({ error: "This biometric ID is already registered to another member" });
    return;
  }

  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.post("/api/payments", requireAuth, requirePermission("billing_management"), (req, res) => {
  const { memberId, amount, method, notes } = req.body || {};
  if (!memberId || !amount || !method) {
    res.status(400).json({ error: "memberId, amount, and method are required" });
    return;
  }
  dbRun(
    "INSERT INTO payments (member_id, amount, method, notes, paid_at) VALUES (?, ?, ?, ?, ?)",
    [Number(memberId), Number(amount), method, notes || "", isoDateFromOffset(0)]
  );
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.post("/api/device-events", async (req, res) => {
  try {
    const result = await processBiometricEvent(req.body || {}, "adms-push");
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/simulate-swipe", requireAuth, requirePermission("mark_attendance_manually"), async (req, res) => {
  try {
    const body = req.body || {};
    const result = await processBiometricEvent({
      deviceSerial: body.deviceSerial || "6583154400429",
      biometricId: body.biometricId,
      eventTime: body.eventTime || nowIso(),
      simulation: true
    }, "dashboard-sim");
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// ZKTeco ADMS ("push protocol") receiver -- the actual protocol your X200 /
// X2008 reader speaks over HTTP once its "ADMS Setup" screen (Comm > Ethernet
// > Cloud Server Setting) points at this server's IP and port.
//
//   GET  /iclock/cdata?SN=...                     -> handshake / heartbeat
//   POST /iclock/cdata?SN=...&table=ATTLOG         -> real-time attendance push
//   POST /iclock/cdata?SN=...&table=OPERLOG        -> enrollment/op logs (ack only)
//   GET  /iclock/getrequest?SN=...                 -> device polls for remote commands
//   POST /iclock/devicecmd?SN=...                  -> device reports command results
//
// No login is possible here -- the reader can't authenticate like a browser.
// Treat network-level access (LAN / VPN / firewall allow-list) as the
// boundary in production.
// ============================================================================

app.all("/iclock/cdata", async (req, res) => {
  const serial = String(req.query.SN || req.query.sn || "").trim();
  const table = req.query.table || req.query.Table;
  const ip = requestIp(req);

  if (!serial) {
    res.status(400).type("text/plain").send("ERROR: missing SN");
    return;
  }

  if (req.method === "GET" && !table) {
    // Device boot / periodic handshake.
    upsertDeviceContact(serial, ip);
    persistDb();
    emitRefresh();
    res.type("text/plain").send(
      `GET OPTION FROM: ${serial}\r\n` +
      "ATTLOGStamp=None\r\n" +
      "OPERLOGStamp=9999\r\n" +
      "ErrorDelay=30\r\n" +
      "Delay=10\r\n" +
      "TransFlag=1111000000\r\n" +
      "Realtime=1\r\n" +
      "Encrypt=None\r\n"
    );
    return;
  }

  if (req.method === "POST" && String(table).toUpperCase() === "ATTLOG") {
    upsertDeviceContact(serial, ip);
    const raw = typeof req.body === "string" ? req.body : "";
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    let processed = 0;
    for (const line of lines) {
      // Standard ZKTeco ATTLOG row: PIN <tab> Timestamp <tab> Status <tab> Verify ...
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      const pin = parts[0].trim();
      const timeRaw = parts[1].trim();
      const eventTime = new Date(timeRaw.replace(" ", "T")).toISOString();
      if (!pin || Number.isNaN(new Date(eventTime).getTime())) continue;

      try {
        await processBiometricEvent(
          { deviceSerial: serial, biometricId: pin, eventTime, verifyStatus: parts[2] || "", verifyMode: parts[3] || "" },
          "zkteco-adms"
        );
        processed += 1;
      } catch (error) {
        storeDeviceEvent(serial, "attlog_error", "Swipe could not be processed", `${line} -> ${error.message}`, "warning");
      }
    }

    persistDb();
    res.type("text/plain").send(`OK: ${processed}`);
    return;
  }

  if (req.method === "POST") {
    // OPERLOG / options / other tables we don't need to persist -- just ack
    // so the device clears its send buffer instead of retrying forever.
    upsertDeviceContact(serial, ip);
    const raw = typeof req.body === "string" ? req.body : "";
    const count = raw.split(/\r?\n/).filter((l) => l.trim()).length;
    persistDb();
    res.type("text/plain").send(`OK: ${count}`);
    return;
  }

  upsertDeviceContact(serial, ip);
  persistDb();
  res.type("text/plain").send("OK");
});

app.get("/iclock/getrequest", (req, res) => {
  const serial = String(req.query.SN || req.query.sn || "").trim();
  if (serial) {
    upsertDeviceContact(serial, requestIp(req));
    persistDb();
  }
  // No remote commands queued for the device right now.
  res.type("text/plain").send("OK");
});

app.post("/iclock/devicecmd", (req, res) => {
  const serial = String(req.query.SN || req.query.sn || "").trim();
  if (serial) {
    upsertDeviceContact(serial, requestIp(req));
    persistDb();
  }
  res.type("text/plain").send("OK");
});

app.post("/api/devices/:serial/health-check", requireAuth, requirePermission("attendance_access"), (req, res) => {
  const device = dbGet("SELECT * FROM devices WHERE serial = ?", [req.params.serial]);
  if (!device) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  const eventTime = nowIso();
  dbRun("UPDATE devices SET last_seen_at = ?, health = 'online' WHERE serial = ?", [eventTime, device.serial]);
  storeDeviceEvent(device.serial, "health_check", "Health check passed", `Device responded at ${device.ip_address} and ADMS ${device.adms_host}:${device.adms_port}.`, "info", eventTime);
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.post("/api/devices", requireAuth, requirePermission("attendance_access"), (req, res) => {
  const { serial, label, model, macAddress, ipAddress, admsHost, admsPort } = req.body || {};
  if (!serial || !label) {
    res.status(400).json({ error: "serial and label are required" });
    return;
  }
  if (dbGet("SELECT serial FROM devices WHERE serial = ?", [serial])) {
    res.status(400).json({ error: "A device with this serial number already exists" });
    return;
  }
  dbRun(
    `INSERT INTO devices
      (serial, label, model, algorithm, firmware, mac_address, ip_address, subnet_mask, gateway, net_speed, adms_host, adms_port, adms_mode, proxy_server, health, last_seen_at)
     VALUES (?, ?, ?, '', '', ?, ?, '', '', 'Auto', ?, ?, 'IP mode', 'OFF', 'offline', NULL)`,
    [serial, label, model || "ZKTeco", macAddress || "", ipAddress || "", admsHost || "", Number(admsPort) || 0]
  );
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.put("/api/devices/:serial", requireAuth, requirePermission("attendance_access"), (req, res) => {
  const device = dbGet("SELECT * FROM devices WHERE serial = ?", [req.params.serial]);
  if (!device) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  const { label, model, macAddress, ipAddress, admsHost, admsPort } = req.body || {};
  dbRun(
    "UPDATE devices SET label = ?, model = ?, mac_address = ?, ip_address = ?, adms_host = ?, adms_port = ? WHERE serial = ?",
    [
      label || device.label,
      model || device.model,
      macAddress ?? device.mac_address,
      ipAddress ?? device.ip_address,
      admsHost ?? device.adms_host,
      admsPort !== undefined ? Number(admsPort) : device.adms_port,
      req.params.serial
    ]
  );
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.delete("/api/devices/:serial", requireAuth, requirePermission("delete_access"), (req, res) => {
  dbRun("DELETE FROM devices WHERE serial = ?", [req.params.serial]);
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

// ============================================================================
// Staff & permissions
// ============================================================================

app.get("/api/staff", requireAuth, requirePermission("staff_management"), (req, res) => {
  const rows = dbAll("SELECT id, name, email, role, permissions, active, created_at FROM staff ORDER BY created_at ASC")
    .map((row) => ({ ...row, permissions: JSON.parse(row.permissions || "[]"), active: !!row.active }));
  res.json(rows);
});

app.post("/api/staff", requireAuth, requirePermission("staff_management"), (req, res) => {
  const { name, email, password, role, permissions } = req.body || {};
  if (!name || !email || !password) {
    res.status(400).json({ error: "name, email and password are required" });
    return;
  }
  if (dbGet("SELECT id FROM staff WHERE lower(email) = ?", [String(email).toLowerCase()])) {
    res.status(400).json({ error: "A staff account with this email already exists" });
    return;
  }
  dbRun(
    "INSERT INTO staff (name, email, password_hash, role, permissions, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    [name, email, hashPassword(password), role || "operator", JSON.stringify(permissions || []), nowIso()]
  );
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.put("/api/staff/:id", requireAuth, requirePermission("staff_management"), (req, res) => {
  const staffRow = dbGet("SELECT * FROM staff WHERE id = ?", [req.params.id]);
  if (!staffRow) {
    res.status(404).json({ error: "Staff member not found" });
    return;
  }
  const { name, role, permissions, active, password } = req.body || {};
  dbRun(
    "UPDATE staff SET name = ?, role = ?, permissions = ?, active = ? WHERE id = ?",
    [
      name || staffRow.name,
      role || staffRow.role,
      JSON.stringify(permissions ?? JSON.parse(staffRow.permissions || "[]")),
      active === undefined ? staffRow.active : (active ? 1 : 0),
      req.params.id
    ]
  );
  if (password) {
    dbRun("UPDATE staff SET password_hash = ? WHERE id = ?", [hashPassword(password), req.params.id]);
  }
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.delete("/api/staff/:id", requireAuth, requirePermission("delete_access"), (req, res) => {
  const staffRow = dbGet("SELECT * FROM staff WHERE id = ?", [req.params.id]);
  if (staffRow && staffRow.role === "owner") {
    res.status(400).json({ error: "The owner account cannot be removed" });
    return;
  }
  dbRun("DELETE FROM staff WHERE id = ?", [req.params.id]);
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

// ============================================================================
// Expenses
// ============================================================================

app.post("/api/expenses", requireAuth, requirePermission("expense_management"), (req, res) => {
  const { category, description, amount, expenseDate } = req.body || {};
  if (!category || !amount) {
    res.status(400).json({ error: "category and amount are required" });
    return;
  }
  dbRun(
    "INSERT INTO expenses (category, description, amount, expense_date, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [category, description || "", Number(amount), expenseDate || isoDateFromOffset(0), req.staff.name, nowIso()]
  );
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.delete("/api/expenses/:id", requireAuth, requirePermission("delete_access"), (req, res) => {
  dbRun("DELETE FROM expenses WHERE id = ?", [req.params.id]);
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

// ============================================================================
// Group classes
// ============================================================================

app.post("/api/classes", requireAuth, requirePermission("group_class_management"), (req, res) => {
  const { name, trainer, days, startTime, capacity, description } = req.body || {};
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  dbRun(
    "INSERT INTO classes (name, trainer, days, start_time, capacity, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [name, trainer || "", days || "", startTime || "", Number(capacity) || 20, description || "", nowIso()]
  );
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.delete("/api/classes/:id", requireAuth, requirePermission("delete_access"), (req, res) => {
  dbRun("DELETE FROM classes WHERE id = ?", [req.params.id]);
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.post("/api/classes/:id/book", requireAuth, requirePermission("group_class_management"), (req, res) => {
  const cls = dbGet("SELECT * FROM classes WHERE id = ?", [req.params.id]);
  if (!cls) {
    res.status(404).json({ error: "Class not found" });
    return;
  }
  const bookedCount = dbGet(
    "SELECT COUNT(*) AS c FROM class_bookings WHERE class_id = ? AND status = 'booked'", [req.params.id]
  ).c;
  if (bookedCount >= cls.capacity) {
    res.status(400).json({ error: "This class is at capacity" });
    return;
  }
  const { memberId } = req.body || {};
  if (!memberId) {
    res.status(400).json({ error: "memberId is required" });
    return;
  }
  dbRun(
    "INSERT INTO class_bookings (class_id, member_id, booking_date, status) VALUES (?, ?, ?, 'booked')",
    [req.params.id, Number(memberId), isoDateFromOffset(0)]
  );
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

// ============================================================================
// Unmatched biometric swipes -> map to a member without losing the event
// ============================================================================

app.put("/api/members/:id/biometric", requireAuth, requirePermission("member_management"), (req, res) => {
  const member = dbGet("SELECT * FROM members WHERE id = ?", [req.params.id]);
  if (!member) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  const { biometricId } = req.body || {};
  if (!biometricId) {
    res.status(400).json({ error: "biometricId is required" });
    return;
  }
  const clash = dbGet("SELECT id FROM members WHERE biometric_id = ? AND id != ?", [biometricId, req.params.id]);
  if (clash) {
    res.status(400).json({ error: "This biometric ID is already assigned to another member" });
    return;
  }
  dbRun("UPDATE members SET biometric_id = ? WHERE id = ?", [biometricId, req.params.id]);
  // Backfill any previously unmatched logs with this PIN so history isn't lost.
  dbRun("UPDATE access_logs SET member_id = ? WHERE biometric_id = ? AND member_id IS NULL", [req.params.id, biometricId]);
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

// ============================================================================
// Membership request approvals (new members submitted via the public kiosk)
// ============================================================================

app.post("/api/membership-requests/:id/approve", requireAuth, requirePermission("approve_membership_requests"), (req, res) => {
  const request = dbGet("SELECT * FROM membership_requests WHERE id = ?", [req.params.id]);
  if (!request) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  if (request.status !== "pending") {
    res.status(400).json({ error: `This request was already ${request.status}` });
    return;
  }
  const duplicate = findDuplicateMember({ phone: request.phone, biometricId: request.biometric_id });
  if (duplicate) {
    res.status(409).json({ error: `Can't approve: ${duplicate.error} Reject this request or resolve the conflict first.` });
    return;
  }
  const { coachId, expiresAt } = req.body || {};
  const finalCoachId = coachId ? Number(coachId) : request.coach_id;
  if (!finalCoachId) {
    res.status(400).json({ error: "Please choose a coach before approving" });
    return;
  }
  const plan = dbGet("SELECT * FROM plans WHERE id = ?", [request.plan_id]);
  if (!plan) {
    res.status(400).json({ error: "The plan on this request no longer exists" });
    return;
  }
  const finalExpiresAt = expiresAt || isoDateFromOffset(plan.duration_days);

  try {
    dbRun(
      `INSERT INTO members
        (full_name, phone, emergency_contact, goal, plan_id, coach_id, biometric_id, access_enabled, status, join_date, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)`,
      [
        request.full_name, request.phone, "Not provided", request.goal || "General Fitness",
        request.plan_id, finalCoachId, request.biometric_id,
        isoDateFromOffset(0), finalExpiresAt, nowIso()
      ]
    );
  } catch (error) {
    res.status(409).json({ error: "This fingerprint is already registered to another member" });
    return;
  }
  dbRun(
    "UPDATE membership_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ?",
    [nowIso(), req.staff.name, req.params.id]
  );
  // Any earlier denied swipes from this PIN (before they were a member) now resolve to them.
  const newMember = dbGet("SELECT id FROM members WHERE biometric_id = ?", [request.biometric_id]);
  dbRun("UPDATE access_logs SET member_id = ? WHERE biometric_id = ? AND member_id IS NULL", [newMember.id, request.biometric_id]);

  persistDb();
  emitRefresh();
  res.json({ ok: true, memberId: newMember.id });
});

app.post("/api/membership-requests/:id/reject", requireAuth, requirePermission("approve_membership_requests"), (req, res) => {
  const request = dbGet("SELECT * FROM membership_requests WHERE id = ?", [req.params.id]);
  if (!request) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  if (request.status !== "pending") {
    res.status(400).json({ error: `This request was already ${request.status}` });
    return;
  }
  dbRun(
    "UPDATE membership_requests SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, rejection_reason = ? WHERE id = ?",
    [nowIso(), req.staff.name, (req.body && req.body.reason) || "", req.params.id]
  );
  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

io.use((socket, next) => {
  const staff = getStaffFromRequest({ headers: socket.handshake.headers });
  if (!staff) {
    next(new Error("unauthorized"));
    return;
  }
  next();
});

io.on("connection", (socket) => {
  socket.emit("gym:update", buildBootstrap());
});

// Public, unauthenticated namespace for the front-desk kiosk (public/welcome.html).
// It only ever receives a ping that a PIN just scanned and wasn't recognized --
// no member data -- so it's safe to leave open to anyone on the local network,
// unlike the main dashboard namespace above.
const kioskIo = io.of("/kiosk");
kioskIo.on("connection", () => {});

function notifyKiosk(biometricId, deviceSerial) {
  kioskIo.emit("kiosk:new-swipe", { biometricId, deviceSerial, at: nowIso() });
}

async function start() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve("sql.js/dist/sql-wasm.wasm")), file)
  });

  db = fs.existsSync(DATA_FILE)
    ? new SQL.Database(fs.readFileSync(DATA_FILE))
    : new SQL.Database();

  ensureSchema();

  server.listen(PORT, () => {
    console.log(`Tiger Gym Live listening on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
