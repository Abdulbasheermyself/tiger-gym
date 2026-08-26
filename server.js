const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const dgram = require("dgram");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const http = require("http");
const express = require("express");
const initSqlJs = require("sql.js");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 5000);
const PRIMARY_DATA_FILE = path.join(__dirname, "data", "tiger_gym.db");
const FALLBACK_DATA_FILE = path.join(__dirname, "data", "tiger_gym.recovery.db");
const DOOR_TRIGGER_MODE = String(process.env.DOOR_TRIGGER_MODE || "simulation").toLowerCase();
const DOOR_TRIGGER_URL = process.env.DOOR_TRIGGER_URL || "";
const ACCESS_WEBHOOK_SECRET = process.env.ACCESS_WEBHOOK_SECRET || "";

// Finds this machine's actual primary LAN IP the same way the OS itself
// would: open a UDP "connection" toward an external address (no packets are
// actually sent — UDP connect() just resolves a route) and ask which local
// address the OS would use for that route. This is the OS's own definition
// of "primary outbound IP," so it correctly follows whatever network this
// machine is actually on — no adapter-name guessing, no stale/hardcoded
// address, and it naturally ignores virtual adapters (Hyper-V/WSL/VMware/
// VirtualBox) since those aren't on the route to the real network.
function getPrimaryLanIp() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", () => {
      socket.close();
      resolve(fallbackLanIp());
    });
    try {
      socket.connect(80, "8.8.8.8", () => {
        const address = socket.address().address;
        socket.close();
        resolve(address || fallbackLanIp());
      });
    } catch {
      socket.close();
      resolve(fallbackLanIp());
    }
  });
}

// Only used if the OS routing trick above can't resolve anything at all
// (e.g. no default route configured) — picks the first non-internal IPv4
// address as a last resort so the app can still function.
function fallbackLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

let LAN_IP = null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "2mb" }));
app.use("/iclock", express.text({ type: () => true, limit: "5mb" }));

let db;
let dataFile = PRIMARY_DATA_FILE;

// ============================================================================
// Auth / Session
// ============================================================================

const SESSION_COOKIE = "tg_session";
const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

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

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  try {
    const check = crypto.scryptSync(String(password), salt, 64).toString("hex");
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(check, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const result = {};
  for (const part of header.split(";")) {
    const item = part.trim();
    if (!item) continue;
    const idx = item.indexOf("=");
    if (idx < 0) continue;
    const key = decodeURIComponent(item.slice(0, idx));
    const value = decodeURIComponent(item.slice(idx + 1));
    result[key] = value;
  }
  return result;
}

function createSession(staffId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { staffId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function getStaffFromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  const staff = dbGet(
    "SELECT * FROM staff WHERE id = ? AND active = 1",
    [session.staffId]
  );

  return staff || null;
}

function staffPermissions(staff) {
  if (!staff) return [];
  if (staff.role === "owner") return PERMISSION_KEYS.map((p) => p.key);
  return parseJsonArray(staff.permissions);
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

// ============================================================================
// Database helpers
// ============================================================================

function preferredDataFile() {
  const candidates = [PRIMARY_DATA_FILE, FALLBACK_DATA_FILE]
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0]?.file || PRIMARY_DATA_FILE;
}

function persistDb() {
  fs.mkdirSync(path.dirname(PRIMARY_DATA_FILE), { recursive: true });
  const bytes = Buffer.from(db.export());

  try {
    fs.writeFileSync(dataFile, bytes);
  } catch (error) {
    const canFallback = dataFile !== FALLBACK_DATA_FILE
      && (error.code === "EPERM" || error.code === "EBUSY");
    if (!canFallback) throw error;

    dataFile = FALLBACK_DATA_FILE;
    fs.writeFileSync(dataFile, bytes);
    console.warn(`Primary database file is locked; using fallback database at ${dataFile}`);
  }
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

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeStaff(staff) {
  if (!staff) return null;
  return {
    ...staff,
    active: !!staff.active,
    permissions: staff.role === "owner"
      ? PERMISSION_KEYS.map((permission) => permission.key)
      : parseJsonArray(staff.permissions)
  };
}

function nowIso() {
  return new Date().toISOString();
}

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

// ============================================================================
// Seed data
// ============================================================================

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
    ["6583154400429", "Tiger Gate Reader", "X200", "Finger VX10.0", "Ver 6.81 (build 367)",
      "00:17:61:10:1b:16", "192.168.1.201", "255.255.255.0", "192.168.1.1", "Auto",
      "20.244.9.194", 80, "IP mode", "OFF", "online", null],
    ["6583154400429-B", "Tiger Gate Reader Backup Route", "X200", "Finger VX10.0", "Ver 6.81 (build 367)",
      "00:17:61:10:1b:16", "192.168.1.201", "255.255.255.0", "192.168.1.1", "Auto",
      "13.127.100.164", 81, "IP mode", "OFF", "standby", null]
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

// ============================================================================
// Schema
// ============================================================================

function ensureSchema() {
  const statements = [
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
      role TEXT NOT NULL DEFAULT 'staff',
      permissions TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS membership_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      biometric_id TEXT NOT NULL,
      device_serial TEXT,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      goal TEXT,
      plan_id INTEGER NOT NULL,
      coach_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by INTEGER,
      rejection_reason TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      notes TEXT,
      expense_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS group_classes (
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
      booked_at TEXT NOT NULL,
      UNIQUE (class_id, member_id),
      FOREIGN KEY (class_id) REFERENCES group_classes(id),
      FOREIGN KEY (member_id) REFERENCES members(id)
    )`
  ];

  statements.forEach(dbRun);

  // ----------------------------------------------------------------------
  // Migrations: CREATE TABLE IF NOT EXISTS does nothing to tables that
  // already exist, so any column added to the schema above after a
  // database file was first created would otherwise be silently missing.
  // This adds any columns that aren't present yet on existing tables.
  // ----------------------------------------------------------------------
  const expectedColumns = {
    expenses: [
      ["notes", "TEXT"]
    ]
  };

  for (const [table, columns] of Object.entries(expectedColumns)) {
    const existing = new Set(dbAll(`PRAGMA table_info(${table})`).map((col) => col.name));
    for (const [columnName, columnType] of columns) {
      if (!existing.has(columnName)) {
        dbRun(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${columnType}`);
        console.log(`Migrated: added column "${columnName}" to "${table}"`);
      }
    }
  }

  // Phone is the primary human identifier for a member now that biometric_id
  // is assigned later (at approval) rather than at registration time. Enforce
  // uniqueness at the DB level, not just in application logic. This can fail
  // on a pre-existing database that already has duplicate phone numbers —
  // that's surfaced as a console warning rather than crashing startup, since
  // cleaning up existing duplicate data is a decision for the gym, not code.
  try {
    dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_members_phone ON members(phone)");
  } catch (error) {
    console.warn(
      `Could not enforce unique phone numbers on "members" (likely existing duplicates): ${error.message}`
    );
  }

  if (!dbGet("SELECT id FROM plans LIMIT 1")) {
    seed.plans.forEach((row) => dbRun(
      "INSERT INTO plans (name, duration_days, price, category) VALUES (?, ?, ?, ?)", row
    ));
  }

  if (!dbGet("SELECT id FROM coaches LIMIT 1")) {
    seed.coaches.forEach((row) => dbRun(
      "INSERT INTO coaches (name, specialty, active_clients, sessions_today, availability) VALUES (?, ?, ?, ?, ?)", row
    ));
  }

  if (!dbGet("SELECT id FROM members LIMIT 1")) {
    seed.members.forEach((row) => dbRun(
      `INSERT INTO members
       (full_name, phone, emergency_contact, goal, plan_id, coach_id, biometric_id,
        access_enabled, status, join_date, expires_at, created_at)
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
       (serial, label, model, algorithm, firmware, mac_address, ip_address, subnet_mask,
        gateway, net_speed, adms_host, adms_port, adms_mode, proxy_server, health, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row
    ));
  }

  if (!dbGet("SELECT id FROM attendance_logs LIMIT 1")) {
    seed.attendance.forEach((row) => dbRun(
      `INSERT INTO attendance_logs
       (member_id, device_serial, biometric_id, source, result, event_time, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row[0], row[1], row[2], row[3], row[4],
       isoDateTime(row[5], row[6], row[7]), JSON.stringify({ seeded: true })]
    ));
  }

  if (!dbGet("SELECT id FROM access_logs LIMIT 1")) {
    seed.attendance.forEach((row) => dbRun(
      `INSERT INTO access_logs
       (member_id, device_serial, biometric_id, granted, reason, door_action, door_detail,
        source, event_time, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row[0], row[1], row[2], row[4] === "granted" ? 1 : 0,
        "Seeded grant", "simulated_unlock", "Seed data", row[3],
        isoDateTime(row[5], row[6], row[7]), JSON.stringify({ seeded: true })
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
      "INSERT INTO workouts (title, audience, schedule, blocks) VALUES (?, ?, ?, ?)", row
    ));
  }

  // Create a local owner account only when staff table is empty.
  // Change this password immediately for any non-demo deployment.
  if (!dbGet("SELECT id FROM staff LIMIT 1")) {
    dbRun(
      `INSERT INTO staff
       (name, email, password_hash, role, permissions, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [
        "Gym Owner",
        process.env.DEFAULT_ADMIN_EMAIL || "admin@tigergym.local",
        hashPassword(process.env.DEFAULT_ADMIN_PASSWORD || "ChangeMe123!"),
        "owner",
        JSON.stringify(PERMISSION_KEYS.map((p) => p.key)),
        nowIso()
      ]
    );
    console.warn("Demo owner account created. Change DEFAULT_ADMIN_PASSWORD before production use.");
  }

  persistDb();
}

// ============================================================================
// Member / dashboard utilities
// ============================================================================

// Strips spaces, dashes, parens, dots, and a leading "+91"/"91" country code
// so "987-654 3210", "(987) 654-3210", and "+91 9876543210" all normalize to
// the same 10-digit value before validation/lookup/storage.
function normalizePhoneDigits(value) {
  let digits = String(value || "").replace(/[\s\-().]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
  return digits;
}

function findDuplicateMember({ phone, biometricId, excludeMemberId } = {}) {
  if (biometricId) {
    const existing = dbGet(
      "SELECT id, full_name, status FROM members WHERE biometric_id = ?",
      [String(biometricId).trim()]
    );
    if (existing && existing.id !== excludeMemberId) {
      return {
        error: "Member already exist.",
        detail: `${existing.full_name} is already using this biometric ID.`,
        field: "biometricId",
        existingMemberId: existing.id
      };
    }
  }

  if (phone) {
    const existing = dbGet(
      "SELECT id, full_name, status FROM members WHERE phone = ? AND status = 'active'",
      [String(phone).trim()]
    );
    if (existing && existing.id !== excludeMemberId) {
      return {
        error: "Member already exist.",
        detail: `${existing.full_name} already has this phone number.`,
        field: "phone",
        existingMemberId: existing.id
      };
    }
  }

  return null;
}

function buildBootstrap() {
  const members = dbAll(`
    SELECT m.id, m.full_name, m.phone, m.emergency_contact, m.goal, m.biometric_id,
           m.access_enabled, m.status, m.join_date, m.expires_at,
           p.name AS plan_name, p.price AS plan_price, p.category AS plan_category,
           c.name AS coach_name, c.specialty AS coach_specialty
    FROM members m
    JOIN plans p ON p.id = m.plan_id
    JOIN coaches c ON c.id = m.coach_id
    ORDER BY date(m.expires_at) ASC, m.full_name ASC
  `).map((row) => ({ ...row, access_enabled: !!row.access_enabled }));

  const plans = dbAll("SELECT * FROM plans ORDER BY price ASC");
  const coaches = dbAll("SELECT * FROM coaches ORDER BY name ASC");
  const payments = dbAll(`
    SELECT p.*, m.full_name
    FROM payments p JOIN members m ON m.id = p.member_id
    ORDER BY date(p.paid_at) DESC, p.id DESC
  `);

  const attendance = dbAll(`
    SELECT a.*, m.full_name
    FROM attendance_logs a JOIN members m ON m.id = a.member_id
    ORDER BY datetime(a.event_time) DESC, a.id DESC LIMIT 20
  `);

  const accessLogs = dbAll(`
    SELECT al.*, m.full_name
    FROM access_logs al LEFT JOIN members m ON m.id = al.member_id
    ORDER BY datetime(al.event_time) DESC, al.id DESC LIMIT 20
  `).map((row) => ({ ...row, granted: !!row.granted }));

  const devices = dbAll("SELECT * FROM devices ORDER BY serial ASC");
  const deviceEvents = dbAll(
    "SELECT * FROM device_events ORDER BY datetime(event_time) DESC, id DESC LIMIT 20"
  );

  const workouts = dbAll("SELECT * FROM workouts ORDER BY id ASC").map((row) => ({
    ...row,
    blocks: row.blocks.split("|").map((item) => item.trim())
  }));

  const membershipRequests = dbAll(`
    SELECT r.id, r.biometric_id, r.device_serial, r.full_name, r.phone, r.email,
           r.goal, r.plan_id, r.coach_id, r.status, r.submitted_at, r.reviewed_at,
           r.rejection_reason, p.name AS plan_name, p.price AS plan_price,
           c.name AS coach_name, reviewer.name AS reviewed_by
    FROM membership_requests r
    LEFT JOIN plans p ON p.id = r.plan_id
    LEFT JOIN coaches c ON c.id = r.coach_id
    LEFT JOIN staff reviewer ON reviewer.id = r.reviewed_by
    ORDER BY datetime(r.submitted_at) DESC, r.id DESC
  `);

  const expenses = dbAll(`
    SELECT id, category, amount, notes AS description, expense_date, created_at,
           NULL AS added_by
    FROM expenses
    ORDER BY date(expense_date) DESC, id DESC
  `);

  const classes = dbAll(`
    SELECT gc.id, gc.name, gc.trainer, gc.days, gc.start_time, gc.capacity, gc.description,
           COUNT(cb.id) AS booked_count
    FROM group_classes gc
    LEFT JOIN class_bookings cb ON cb.class_id = gc.id
    GROUP BY gc.id, gc.name, gc.trainer, gc.days, gc.start_time, gc.capacity, gc.description
    ORDER BY gc.days ASC, gc.start_time ASC, gc.id DESC
  `).map((row) => ({
    ...row,
    capacity: Number(row.capacity),
    booked_count: Number(row.booked_count)
  }));

  const staff = dbAll(`
    SELECT id, name, email, role, permissions, active, created_at
    FROM staff
    ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, name ASC
  `).map(normalizeStaff);

  const unmatchedSwipeRows = dbAll(`
    SELECT biometric_id, device_serial, event_time
    FROM access_logs
    WHERE granted = 0 AND member_id IS NULL AND biometric_id <> ''
    ORDER BY datetime(event_time) DESC, id DESC
  `);

  const unmatchedByBiometric = new Map();
  for (const row of unmatchedSwipeRows) {
    const existing = unmatchedByBiometric.get(row.biometric_id);
    if (existing) {
      existing.attempts += 1;
      continue;
    }

    unmatchedByBiometric.set(row.biometric_id, {
      biometric_id: row.biometric_id,
      device_serial: row.device_serial,
      last_seen: row.event_time,
      attempts: 1
    });
  }
  const unmatchedSwipes = [...unmatchedByBiometric.values()];

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayIso = startOfToday.toISOString();
  const monthPrefix = startOfToday.toISOString().slice(0, 7);

  const activeMembers = members.filter((m) => m.status === "active").length;
  const renewalsDue = members.filter((m) => m.expires_at <= isoDateFromOffset(7)).length;
  const todayCheckins = attendance.filter((a) => a.event_time >= todayIso).length;
  const todayAccess = accessLogs.filter((a) => a.event_time >= todayIso);
  const monthRevenue = payments
    .filter((p) => String(p.paid_at).startsWith(monthPrefix))
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const monthExpenses = expenses
    .filter((expense) => String(expense.expense_date).startsWith(monthPrefix))
    .reduce((sum, expense) => sum + Number(expense.amount), 0);
  const pendingApprovals = membershipRequests.filter((request) => request.status === "pending").length;

  return {
    summary: {
      activeMembers,
      renewalsDue,
      todayCheckins,
      monthRevenue,
      monthExpenses,
      grantedToday: todayAccess.filter((x) => x.granted).length,
      deniedToday: todayAccess.filter((x) => !x.granted).length
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
    membershipRequests,
    expenses,
    classes,
    staff,
    permissionKeys: PERMISSION_KEYS,
    pendingApprovals,
    unmatchedSwipes
  };
}

function emitRefresh() {
  io.emit("gym:update", buildBootstrap());
}

function resolveAccess(member) {
  if (!member) return { granted: false, reason: "Unknown biometric ID" };
  if (!member.access_enabled) return { granted: false, reason: "Access disabled for this member" };
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
    `INSERT INTO device_events
     (device_serial, event_type, title, detail, severity, event_time)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [deviceSerial, eventType, title, detail, severity, eventTime]
  );
}

async function processBiometricEvent(payload, source = "adms-push") {
  const deviceSerial = String(payload.deviceSerial || "").trim();
  const biometricId = String(payload.biometricId || payload.userCode || "").trim();
  const eventTime = payload.eventTime || nowIso();

  if (!deviceSerial) throw new Error("deviceSerial is required");
  if (!biometricId) throw new Error("biometricId is required");

  const device = dbGet(
    "SELECT * FROM devices WHERE serial = ? OR serial LIKE ? LIMIT 1",
    [deviceSerial, `${deviceSerial}%`]
  );
  if (!device) throw new Error("Unknown device serial");

  dbRun(
    "UPDATE devices SET last_seen_at = ?, health = 'online' WHERE serial = ?",
    [eventTime, device.serial]
  );

  const member = dbGet(
    "SELECT * FROM members WHERE biometric_id = ?",
    [biometricId]
  );

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
     (member_id, device_serial, biometric_id, granted, reason, door_action,
      door_detail, source, event_time, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      member ? member.id : null,
      device.serial,
      biometricId,
      decision.granted ? 1 : 0,
      decision.reason,
      doorAction,
      doorDetail,
      source,
      eventTime,
      rawPayload
    ]
  );

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
  notifyKiosk(biometricId, device.serial);

  return {
    granted: decision.granted,
    reason: decision.reason,
    doorAction,
    doorDetail,
    member: member
      ? { id: member.id, fullName: member.full_name, biometricId: member.biometric_id }
      : null
  };
}

// ============================================================================
// Pages
// ============================================================================

app.get("/", (req, res) => {
  if (!getStaffFromRequest(req)) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
  if (getStaffFromRequest(req)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/welcome", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "welcome.html"));
});

// New member registration page
app.get("/newmember", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "newmember.html"));
});

// Static assets after explicit protected root route.
app.use(express.static(path.join(__dirname, "public")));

// app.js loads modal markup from /modals/<name>.html at startup; the modal
// partials live flat in public/ alongside the other pages, so re-mount the
// same directory under /modals so those fetches resolve correctly.
app.use("/modals", express.static(path.join(__dirname, "public")));

// ============================================================================
// Auth routes
// ============================================================================

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();

  const staff = dbGet(
    "SELECT * FROM staff WHERE lower(email) = ? AND active = 1",
    [normalizedEmail]
  );

  if (!staff || !verifyPassword(password || "", staff.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = createSession(staff.id);

  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`
  );

  res.json({
    ok: true,
    staff: {
      id: staff.id,
      name: staff.name,
      email: staff.email,
      role: staff.role
    }
  });
});

app.post("/api/logout", (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  destroySession(token);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
  );
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const staff = getStaffFromRequest(req);
  if (!staff) return res.status(401).json({ error: "Not logged in" });

  res.json({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    role: staff.role,
    permissions: staffPermissions(staff)
  });
});

// ============================================================================
// Public membership routes
// ============================================================================

app.get("/api/public/plans", (_req, res) => {
  res.json(dbAll(
    "SELECT id, name, duration_days, price, category FROM plans ORDER BY price ASC"
  ));
});

app.get("/api/public/coaches", (_req, res) => {
  res.json(dbAll(
    "SELECT id, name, specialty FROM coaches ORDER BY name ASC"
  ));
});

app.post("/api/public/membership-requests", (req, res) => {
  const { biometricId, fullName, phone, email, goal, planId, coachId, deviceSerial } = req.body || {};
  const normalizedBiometricId = String(biometricId || "").trim();
  const normalizedPhone = normalizePhoneDigits(phone);

  if (!fullName || !normalizedPhone || !planId) {
    return res.status(400).json({
      error: "fullName, phone, and planId are required"
    });
  }

  if (!/^\d{10}$/.test(normalizedPhone)) {
    return res.status(400).json({
      error: "phone must be a valid 10-digit mobile number"
    });
  }

  // biometricId is optional here — if the member doesn't have one yet (e.g.
  // they registered by scanning a general QR code rather than a device
  // swipe), an admin assigns it later when approving the request.
  const duplicate = findDuplicateMember({
    phone: normalizedPhone,
    biometricId: normalizedBiometricId || undefined
  });

  if (duplicate) {
    return res.status(409).json({
      error: "Member already exist.",
      detail: duplicate.detail || duplicate.error
    });
  }

  // If this phone already has a pending request (e.g. they scan the QR
  // again to fix a typo, or resubmit after a device swipe added a
  // biometricId), update that request in place rather than blocking them
  // with an error — same idea as an upsert-on-phone pattern.
  const existingPending = dbGet(
    `SELECT id FROM membership_requests
     WHERE status = 'pending' AND (phone = ? OR (biometric_id <> '' AND biometric_id = ?))`,
    [normalizedPhone, normalizedBiometricId]
  );

  if (existingPending) {
    dbRun(
      `UPDATE membership_requests
       SET biometric_id = ?, device_serial = ?, full_name = ?, phone = ?, email = ?,
           goal = ?, plan_id = ?, coach_id = ?, submitted_at = ?
       WHERE id = ?`,
      [
        normalizedBiometricId,
        deviceSerial || "",
        fullName,
        normalizedPhone,
        email || "",
        goal || "",
        Number(planId),
        coachId ? Number(coachId) : null,
        nowIso(),
        existingPending.id
      ]
    );

    persistDb();
    emitRefresh();

    return res.json({
      ok: true,
      message: "Your existing request has been updated with these details and is still waiting for approval."
    });
  }

  dbRun(
    `INSERT INTO membership_requests
     (biometric_id, device_serial, full_name, phone, email, goal, plan_id, coach_id, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      normalizedBiometricId,
      deviceSerial || "",
      fullName,
      normalizedPhone,
      email || "",
      goal || "",
      Number(planId),
      coachId ? Number(coachId) : null,
      nowIso()
    ]
  );

  persistDb();
  emitRefresh();

  res.json({
    ok: true,
    message: "Thanks! Your request has been sent to the gym manager for approval."
  });
});

// ============================================================================
// Protected dashboard APIs
// ============================================================================

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Tiger Gym Live",
    now: nowIso(),
    port: PORT,
    lanIp: LAN_IP,
    doorMode: DOOR_TRIGGER_MODE,
    webhookConfigured: !!DOOR_TRIGGER_URL
  });
});

app.get("/api/bootstrap", requireAuth, (_req, res) => {
  res.json(buildBootstrap());
});

app.get("/api/permissions", requireAuth, (_req, res) => {
  res.json(PERMISSION_KEYS);
});

app.post("/api/members", requireAuth, requirePermission("member_management"), (req, res) => {
  const { fullName, phone, emergencyContact, goal, planId, coachId, biometricId, expiresAt } = req.body || {};

  if (!fullName || !phone || !goal || !biometricId || !expiresAt || !planId || !coachId) {
    return res.status(400).json({
      error: "fullName, phone, goal, biometricId, expiresAt, planId, and coachId are required"
    });
  }

  const duplicate = findDuplicateMember({ phone, biometricId });
  if (duplicate) return res.status(409).json(duplicate);

  try {
    dbRun(
      `INSERT INTO members
       (full_name, phone, emergency_contact, goal, plan_id, coach_id, biometric_id,
        access_enabled, status, join_date, expires_at, created_at)
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

    persistDb();
    emitRefresh();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.put("/api/members/:id/biometric",
  requireAuth,
  requirePermission("member_management"),
  (req, res) => {
    const member = dbGet("SELECT * FROM members WHERE id = ?", [Number(req.params.id)]);
    if (!member) return res.status(404).json({ error: "Member not found" });

    const biometricId = String(req.body?.biometricId || "").trim();
    if (!biometricId) {
      return res.status(400).json({ error: "biometricId is required" });
    }

    const duplicate = findDuplicateMember({
      biometricId,
      excludeMemberId: member.id
    });
    if (duplicate) return res.status(409).json(duplicate);

    dbRun(
      "UPDATE members SET biometric_id = ? WHERE id = ?",
      [biometricId, member.id]
    );

    dbRun(
      "UPDATE access_logs SET member_id = ? WHERE member_id IS NULL AND biometric_id = ?",
      [member.id, biometricId]
    );

    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

app.post("/api/payments", requireAuth, requirePermission("billing_management"), (req, res) => {
  const { memberId, amount, method, notes } = req.body || {};

  if (!memberId || !amount || !method) {
    return res.status(400).json({
      error: "memberId, amount, and method are required"
    });
  }

  dbRun(
    "INSERT INTO payments (member_id, amount, method, notes, paid_at) VALUES (?, ?, ?, ?, ?)",
    [Number(memberId), Number(amount), method, notes || "", isoDateFromOffset(0)]
  );

  persistDb();
  emitRefresh();
  res.json({ ok: true });
});

app.post("/api/membership-requests/:id/approve",
  requireAuth,
  requirePermission("approve_membership_requests"),
  (req, res) => {
    const request = dbGet(
      "SELECT * FROM membership_requests WHERE id = ? AND status = 'pending'",
      [Number(req.params.id)]
    );

    if (!request) return res.status(404).json({ error: "Pending request not found" });

    // biometricId may already be on the request (device-swipe registration),
    // or the admin assigns one now (QR/self-registration with no ID yet).
    const biometricId = String(req.body?.biometricId || request.biometric_id || "").trim();
    if (!biometricId) {
      return res.status(400).json({ error: "biometricId is required to approve this request" });
    }

    const duplicate = findDuplicateMember({
      phone: request.phone,
      biometricId
    });

    if (duplicate) {
      return res.status(409).json({
        error: "Member already exist.",
        detail: duplicate.detail || duplicate.error
      });
    }

    const plan = dbGet("SELECT * FROM plans WHERE id = ?", [request.plan_id]);
    if (!plan) return res.status(400).json({ error: "Selected plan no longer exists" });

    const coachId = Number(req.body?.coachId || request.coach_id || 1);
    const coach = dbGet("SELECT id FROM coaches WHERE id = ?", [coachId]);
    if (!coach) return res.status(400).json({ error: "Selected coach no longer exists" });

    let expiresAt = String(req.body?.expiresAt || "").trim();
    if (!expiresAt) {
      const expires = new Date();
      expires.setDate(expires.getDate() + Number(plan.duration_days));
      expiresAt = expires.toISOString().slice(0, 10);
    } else if (Number.isNaN(Date.parse(expiresAt))) {
      return res.status(400).json({ error: "expiresAt must be a valid date" });
    }

    dbRun(
      `INSERT INTO members
       (full_name, phone, emergency_contact, goal, plan_id, coach_id, biometric_id,
        access_enabled, status, join_date, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)`,
      [
        request.full_name,
        request.phone,
        "Not provided",
        request.goal || "General Fitness",
        request.plan_id,
        coachId,
        biometricId,
        isoDateFromOffset(0),
        expiresAt,
        nowIso()
      ]
    );

    dbRun(
      `UPDATE membership_requests
       SET status = 'approved', reviewed_at = ?, reviewed_by = ?
       WHERE id = ?`,
      [nowIso(), req.staff.id, request.id]
    );

    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

app.post("/api/membership-requests/:id/reject",
  requireAuth,
  requirePermission("approve_membership_requests"),
  (req, res) => {
    const request = dbGet(
      "SELECT id FROM membership_requests WHERE id = ? AND status = 'pending'",
      [Number(req.params.id)]
    );

    if (!request) return res.status(404).json({ error: "Pending request not found" });

    dbRun(
      `UPDATE membership_requests
       SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, rejection_reason = ?
       WHERE id = ?`,
      [nowIso(), req.staff.id, req.body?.reason || "Rejected by manager", request.id]
    );

    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

app.post("/api/device-events", async (req, res) => {
  try {
    const result = await processBiometricEvent(req.body || {}, "adms-push");
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/simulate-swipe",
  requireAuth,
  requirePermission("mark_attendance_manually"),
  async (req, res) => {
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
  }
);

app.post("/api/devices",
  requireAuth,
  requirePermission("attendance_access"),
  (req, res) => {
    const { serial, label, model, macAddress, ipAddress } = req.body || {};
    const normalizedSerial = String(serial || "").trim();
    const normalizedLabel = String(label || "").trim();

    if (!normalizedSerial || !normalizedLabel) {
      return res.status(400).json({ error: "serial and label are required" });
    }

    const existing = dbGet("SELECT * FROM devices WHERE serial = ?", [normalizedSerial]);

    if (existing) {
      dbRun(
        `UPDATE devices
         SET label = ?, model = ?, mac_address = ?, ip_address = ?
         WHERE serial = ?`,
        [
          normalizedLabel,
          String(model || existing.model || "Unknown model").trim(),
          String(macAddress || existing.mac_address || "").trim(),
          String(ipAddress || existing.ip_address || "").trim(),
          normalizedSerial
        ]
      );
    } else {
      dbRun(
        `INSERT INTO devices
         (serial, label, model, algorithm, firmware, mac_address, ip_address, subnet_mask,
          gateway, net_speed, adms_host, adms_port, adms_mode, proxy_server, health, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          normalizedSerial,
          normalizedLabel,
          String(model || "Unknown model").trim(),
          "Finger VX10.0",
          "Unknown firmware",
          String(macAddress || "").trim(),
          String(ipAddress || "").trim(),
          "255.255.255.0",
          "",
          "Auto",
          "",
          PORT,
          "IP mode",
          "OFF",
          "standby",
          null
        ]
      );
    }

    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

app.post("/api/devices/:serial/health-check",
  requireAuth,
  requirePermission("attendance_access"),
  (req, res) => {
    const device = dbGet("SELECT * FROM devices WHERE serial = ?", [req.params.serial]);

    if (!device) return res.status(404).json({ error: "Device not found" });

    const eventTime = nowIso();

    dbRun(
      "UPDATE devices SET last_seen_at = ?, health = 'online' WHERE serial = ?",
      [eventTime, device.serial]
    );

    storeDeviceEvent(
      device.serial,
      "health_check",
      "Health check passed",
      `Device configured at ${device.ip_address} and ADMS ${device.adms_host}:${device.adms_port}.`,
      "info",
      eventTime
    );

    persistDb();
    emitRefresh();

    res.json({ ok: true });
  }
);

app.delete("/api/devices/:serial",
  requireAuth,
  requirePermission("attendance_access"),
  (req, res) => {
    const device = dbGet("SELECT serial FROM devices WHERE serial = ?", [req.params.serial]);
    if (!device) return res.status(404).json({ error: "Device not found" });

    dbRun("DELETE FROM devices WHERE serial = ?", [device.serial]);
    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

app.patch("/api/members/:id/access",
  requireAuth,
  requirePermission("attendance_access"),
  (req, res) => {
    const member = dbGet("SELECT * FROM members WHERE id = ?", [Number(req.params.id)]);
    if (!member) return res.status(404).json({ error: "Member not found" });

    const enabled = req.body?.enabled ? 1 : 0;

    dbRun(
      "UPDATE members SET access_enabled = ? WHERE id = ?",
      [enabled, member.id]
    );

    persistDb();
    emitRefresh();

    res.json({ ok: true, access_enabled: !!enabled });
  }
);

app.post("/api/expenses",
  requireAuth,
  requirePermission("expense_management"),
  (req, res) => {
    const { category, amount, notes, description, expenseDate } = req.body || {};

    if (!category || !amount) {
      return res.status(400).json({ error: "category and amount are required" });
    }

    dbRun(
      `INSERT INTO expenses (category, amount, notes, expense_date, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        category,
        Number(amount),
        description || notes || "",
        expenseDate || isoDateFromOffset(0),
        nowIso()
      ]
    );

    persistDb();
    emitRefresh();

    res.json({ ok: true });
  }
);

app.delete("/api/expenses/:id",
  requireAuth,
  requirePermission("delete_access"),
  (req, res) => {
    const existing = dbGet("SELECT id FROM expenses WHERE id = ?", [Number(req.params.id)]);
    if (!existing) return res.status(404).json({ error: "Expense not found" });

    dbRun("DELETE FROM expenses WHERE id = ?", [existing.id]);
    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

app.post("/api/classes",
  requireAuth,
  requirePermission("group_class_management"),
  (req, res) => {
    const { name, trainer, days, startTime, capacity, description } = req.body || {};
    const normalizedName = String(name || "").trim();
    const normalizedCapacity = Number(capacity || 0);

    if (!normalizedName || !Number.isFinite(normalizedCapacity) || normalizedCapacity < 1) {
      return res.status(400).json({ error: "name and a valid capacity are required" });
    }

    dbRun(
      `INSERT INTO group_classes
       (name, trainer, days, start_time, capacity, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedName,
        String(trainer || "").trim(),
        String(days || "").trim(),
        String(startTime || "").trim(),
        normalizedCapacity,
        String(description || "").trim(),
        nowIso()
      ]
    );

    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

app.post("/api/classes/:id/book",
  requireAuth,
  requirePermission("group_class_management"),
  (req, res) => {
    const groupClass = dbGet("SELECT * FROM group_classes WHERE id = ?", [Number(req.params.id)]);
    if (!groupClass) return res.status(404).json({ error: "Class not found" });

    const member = dbGet(
      "SELECT id, full_name, status FROM members WHERE id = ?",
      [Number(req.body?.memberId)]
    );
    if (!member) return res.status(404).json({ error: "Member not found" });
    if (member.status !== "active") {
      return res.status(400).json({ error: "Only active members can be booked into classes" });
    }

    const existingBooking = dbGet(
      "SELECT id FROM class_bookings WHERE class_id = ? AND member_id = ?",
      [groupClass.id, member.id]
    );
    if (existingBooking) {
      return res.status(409).json({ error: `${member.full_name} is already booked into this class` });
    }

    const bookingCount = Number(
      dbGet("SELECT COUNT(*) AS count FROM class_bookings WHERE class_id = ?", [groupClass.id])?.count || 0
    );
    if (bookingCount >= Number(groupClass.capacity)) {
      return res.status(409).json({ error: "This class is already at capacity" });
    }

    dbRun(
      "INSERT INTO class_bookings (class_id, member_id, booked_at) VALUES (?, ?, ?)",
      [groupClass.id, member.id, nowIso()]
    );

    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

app.delete("/api/classes/:id",
  requireAuth,
  requirePermission("delete_access"),
  (req, res) => {
    const groupClass = dbGet("SELECT id FROM group_classes WHERE id = ?", [Number(req.params.id)]);
    if (!groupClass) return res.status(404).json({ error: "Class not found" });

    dbRun("DELETE FROM class_bookings WHERE class_id = ?", [groupClass.id]);
    dbRun("DELETE FROM group_classes WHERE id = ?", [groupClass.id]);
    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

app.post("/api/staff",
  requireAuth,
  requirePermission("staff_management"),
  (req, res) => {
    const { name, email, password, role, permissions } = req.body || {};
    const normalizedName = String(name || "").trim();
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedRole = String(role || "operator").trim().toLowerCase() === "owner"
      ? "owner"
      : "operator";
    const passwordValue = String(password || "");

    if (!normalizedName || !normalizedEmail || !passwordValue) {
      return res.status(400).json({ error: "name, email, and password are required" });
    }
    if (passwordValue.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const allowedPermissions = new Set(PERMISSION_KEYS.map((permission) => permission.key));
    const safePermissions = normalizedRole === "owner"
      ? PERMISSION_KEYS.map((permission) => permission.key)
      : [...new Set((Array.isArray(permissions) ? permissions : []).filter((key) => allowedPermissions.has(key)))];

    try {
      dbRun(
        `INSERT INTO staff
         (name, email, password_hash, role, permissions, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [
          normalizedName,
          normalizedEmail,
          hashPassword(passwordValue),
          normalizedRole,
          JSON.stringify(safePermissions),
          nowIso()
        ]
      );
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

app.delete("/api/staff/:id",
  requireAuth,
  requirePermission("staff_management"),
  (req, res) => {
    const staffMember = dbGet("SELECT * FROM staff WHERE id = ?", [Number(req.params.id)]);
    if (!staffMember) return res.status(404).json({ error: "Staff account not found" });
    if (staffMember.role === "owner") {
      return res.status(400).json({ error: "Owner accounts cannot be removed" });
    }
    if (staffMember.id === req.staff.id) {
      return res.status(400).json({ error: "You cannot remove your own account" });
    }

    dbRun("DELETE FROM staff WHERE id = ?", [staffMember.id]);

    for (const [token, session] of sessions.entries()) {
      if (session.staffId === staffMember.id) {
        sessions.delete(token);
      }
    }

    persistDb();
    emitRefresh();
    res.json({ ok: true });
  }
);

// ============================================================================
// ADMS / device push
// ============================================================================

// Basic iClock endpoint. Real device payload formats vary by firmware/model.
// This accepts text and attempts to extract common USERID/PIN fields.
app.all("/iclock/cdata", async (req, res) => {
  try {
    const text = typeof req.body === "string" ? req.body : "";
    const deviceSerial = String(
      req.query.SN || req.headers["x-device-serial"] || ""
    ).trim();

    const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

    for (const line of lines) {
      const parts = line.split(/\s+/);
      const biometricId = parts[0] || "";
      if (!biometricId || !deviceSerial) continue;

      await processBiometricEvent(
        {
          deviceSerial,
          biometricId,
          eventTime: nowIso(),
          raw: line
        },
        "adms-cdata"
      );
    }

    res.type("text").send("OK");
  } catch (error) {
    res.status(400).type("text").send(`ERROR: ${error.message}`);
  }
});

// ============================================================================
// Socket.IO
// ============================================================================

io.use((socket, next) => {
  const cookies = parseCookies({ headers: socket.handshake.headers });
  const token = cookies[SESSION_COOKIE];

  if (!token) return next(new Error("unauthorized"));

  const session = sessions.get(token);

  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return next(new Error("unauthorized"));
  }

  const staff = dbGet(
    "SELECT * FROM staff WHERE id = ? AND active = 1",
    [session.staffId]
  );

  if (!staff) return next(new Error("unauthorized"));

  socket.staff = staff;
  next();
});

io.on("connection", (socket) => {
  socket.emit("gym:update", buildBootstrap());
});

const kioskIo = io.of("/kiosk");

kioskIo.on("connection", (socket) => {
  socket.emit("kiosk:ready", { ok: true });
});

function notifyKiosk(biometricId, deviceSerial) {
  kioskIo.emit("kiosk:new-swipe", {
    biometricId,
    deviceSerial,
    at: nowIso()
  });
}

// ============================================================================
// Start
// ============================================================================

async function start() {
  LAN_IP = await getPrimaryLanIp();

  dataFile = preferredDataFile();
  const SQL = await initSqlJs({
    locateFile: (file) =>
      path.join(path.dirname(require.resolve("sql.js/dist/sql-wasm.wasm")), file)
  });

  db = fs.existsSync(dataFile)
    ? new SQL.Database(fs.readFileSync(dataFile))
    : new SQL.Database();

  ensureSchema();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Tiger Gym Live listening on http://localhost:${PORT}`);
    if (LAN_IP) {
      console.log(`Reachable from phones/devices on this Wi-Fi at: http://${LAN_IP}:${PORT}`);
    } else {
      console.warn("Could not detect a LAN IP — phones on the same Wi-Fi may not be able to reach this server.");
    }
    console.log(`Database: ${dataFile}`);
    console.log(`Door mode: ${DOOR_TRIGGER_MODE}`);
  });
}

start().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});