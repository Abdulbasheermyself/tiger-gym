# Tiger Gym Live

Tiger Gym Live is a backend-driven gym management and biometric access control app.

## What this version does

- Stores members, plans, coaches, payments, attendance logs, access decisions, and device events in a persistent SQL database
- Staff logins with granular, per-account permissions (see below)
- Accepts biometric swipe events over HTTP from a real ZKTeco reader
- Makes access decisions based on member status, expiry, and access enablement
- Issues a door action through a pluggable adapter
- Tracks expenses and runs group classes with capacity-limited bookings
- Streams live updates to the dashboard with Socket.IO — gated to logged-in staff only

## Staff logins & permissions

Every action beyond viewing the dashboard requires a staff login. The first
run seeds one **Owner** account:

```text
admin@tigergym.local / ChangeMe123!
```

Change this password immediately from **Staff & Permissions** after first
login (Staff & Permissions → find your account → set a new password). The
Owner role always has full access; every other account only sees the buttons
for what you've explicitly checked when creating them. Permissions marked
**IMP** (Delete Access, Simulate/Mark Attendance Manually) are sensitive —
grant them only to trusted staff.

Sessions are cookie-based and stored in memory (they reset if the server
restarts, so staff will need to log in again after a restart — this is a
single-process local server, matching how the SQL database itself is held in
memory and flushed to disk on writes).

You can override the seeded owner login by setting `DEFAULT_ADMIN_EMAIL` and
`DEFAULT_ADMIN_PASSWORD` before the first run.

## Important biometric note

This system stores device-generated match events and mapped member IDs, not raw fingerprint templates.
For most deployments that is the safer design: the biometric machine performs matching, and this server stores the resulting swipe event, access decision, and audit trail.

## Real biometric device integration (ZKTeco ADMS)

A physical reader (X200, X2008, etc.) does **not** speak the JSON webhook shown
below — it pushes attendance as raw tab-separated text to a fixed path,
`/iclock/cdata`, using its serial number as a query parameter. This server
implements that real protocol, so a swipe on the physical device now reaches
the database (and the live dashboard) with no extra steps.

On the device: **Comm → Ethernet → Cloud Server Setting (ADMS)**

| Setting | Value |
|---|---|
| Server Mode | ADMS / IP Mode |
| Server Address | this machine's LAN IP (not `localhost`) |
| Server Port | whatever `PORT` this server is running on (default `5000`) |
| Enable Proxy Server | OFF |

Once saved, the reader phones home automatically:
- On boot/heartbeat it registers itself (or updates its last-seen time and IP) in the **Devices** page — no manual setup required, though you can also add a device by hand there if you want to pre-fill its label, MAC address, and IP before it ever connects.
- On every swipe it POSTs the attendance row, which is parsed, matched against `members.biometric_id`, run through the same access-decision logic as the simulator, and written to `attendance_logs` / `access_logs` — then broadcast to every open dashboard tab over Socket.IO.
- A swipe from a fingerprint that isn't mapped to any member is still logged (as a denied access event with reason "Unknown biometric ID") and surfaced in **Devices → Needs enrollment**, where staff with Member Management permission can map it to a member in one click — the historical denied event gets linked to that member too, so nothing is lost.

The device's **serial number** is the only field that must match exactly, since
that's what the hardware actually sends on every request (find it on the
device's own `SysInfo → Device` screen). IP address updates itself
automatically on every contact since DHCP leases can change; MAC address is
for your own reference only, since plain HTTP doesn't expose MAC addresses
across routed networks — the ADMS protocol never sends it.

## New member self-service kiosk

A prospective member can join without staff typing in their details:

1. Front desk enrolls their fingerprint directly on the ZKTeco reader (gives it a PIN) — no member record exists yet.
2. They scan that fingerprint. Since the PIN is unrecognized, the swipe is logged as denied *and* pushed in real time to **`/welcome`** — leave this page open on a tablet or screen at the front desk.
3. The welcome page automatically shows a short form (name, phone, email, goal, membership plan, preferred coach) tied to that scan.
4. On submit, it becomes a **pending membership request** — visible to staff on the dashboard's **Approvals** page (with a live badge showing the count).
5. A staff member with the **Approve New Member Requests** permission reviews it, assigns a coach if one wasn't picked, and approves — this creates the real member record on the spot. The earlier "denied" swipe event is retroactively linked to them, and their *next* swipe grants access normally.

The `/welcome` page requires no login — it's designed to be public-facing on a kiosk device on your gym's local network. It only ever receives a ping that some PIN scanned (no member data), over a separate, unauthenticated Socket.IO namespace (`/kiosk`) kept deliberately apart from the authenticated staff dashboard socket.

**Duplicate protection:** membership requests and manual member creation both check for duplicates two ways — by fingerprint ID (a person already linked to that PIN) *and* by phone number (an existing **active** member with the same number), since someone signing up twice usually does it with a freshly-enrolled fingerprint, not the same PIN. Expired/inactive members with a matching phone are allowed through, since that's a legitimate returning member rather than a duplicate. If two people happen to submit near-simultaneously, the database's own uniqueness constraint on `biometric_id` is the final backstop — you'll get a clean error message instead of a crash either way.

## Door behavior

By default the project runs in `simulation` mode and does **not** energize any real door hardware.

To connect it to a real controller, set:

- `DOOR_TRIGGER_MODE=webhook`
- `DOOR_TRIGGER_URL=https://your-controller-endpoint`

Then, on each granted access, the server will POST a JSON payload to that URL.

## Run

From this folder:

```powershell
npm install
node server.js
```

Copy `.env.example` to `.env` first if you want to change the port (defaults to `5000` if unset) or enable a real door webhook.

Open:

```text
http://localhost:5000
```

You'll be redirected to `/login` on first visit.

## Known limitation

This build keeps things dependency-light (no `express-session`, no `bcrypt`)
by using an in-memory session map and Node's built-in `crypto.scrypt` for
password hashing — appropriate for a single local server, but if you ever run
multiple server instances behind a load balancer, sessions won't be shared
between them. For that scenario, swap the in-memory `sessions` Map in
`server.js` for a shared store (Redis, etc.).

On Windows, if `data/tiger_gym.db` is locked by another process, the server
automatically falls back to `data/tiger_gym.recovery.db` so the app can still
start and persist new changes.

## Event ingestion examples

Manual/testing webhook (used by the dashboard's "Simulate Swipe" button — requires a staff login with "Simulate / Mark Attendance Manually" permission):

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:5000/api/device-events `
  -ContentType 'application/json' `
  -Body '{"deviceSerial":"6583154400429","biometricId":"TG-1001","source":"adms-push"}'
```

What a real ZKTeco reader actually sends (for reference / manual testing with curl — note the raw body is **tab-separated**, not JSON, and this endpoint does not require a login since it's the device-facing route):

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:5000/iclock/cdata?SN=6583154400429&table=ATTLOG" `
  -ContentType 'text/plain' `
  -Body "TG-1001`t2026-08-20 16:42:00`t0`t1"
```
