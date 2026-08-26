// Add this near the top, after other requires
const sessions = new Map(); // token -> { staffId, expiresAt }

// Fix the Socket.IO authentication middleware
io.use((socket, next) => {
  const cookies = parseCookies({ headers: socket.handshake.headers });
  const token = cookies[SESSION_COOKIE];
  if (!token) {
    next(new Error("unauthorized"));
    return;
  }
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    next(new Error("unauthorized"));
    return;
  }
  const staff = dbGet("SELECT * FROM staff WHERE id = ? AND active = 1", [session.staffId]);
  if (!staff) {
    next(new Error("unauthorized"));
    return;
  }
  socket.staff = staff;
  next();
});

// Fix the kiosk namespace (should be before the main connection handler)
const kioskIo = io.of("/kiosk");
kioskIo.on("connection", () => {});