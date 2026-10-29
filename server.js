require("dotenv").config();
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.SESSION_SECRET || !process.env.ADMIN_PASSWORD || !process.env.ADMIN_USERNAME) {
  console.error("Bitte SESSION_SECRET, ADMIN_USERNAME und ADMIN_PASSWORD in .env setzen.");
  process.exit(1);
}
if (process.env.ADMIN_PASSWORD.length < 12) {
  console.error("ADMIN_PASSWORD muss mindestens 12 Zeichen lang sein.");
  process.exit(1);
}

const db = new Database(path.join(DATA_DIR, "orders.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    restaurant_name TEXT NOT NULL,
    items_json TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Neu'
  );
`);

const menus = {
  cherry: {
    id: "cherry",
    name: "Cherry Mattersburg",
    description: "Speisekarte bitte vor dem Live-Start mit dem Restaurant bestätigen.",
    items: [
      { id: "cherry-burger", name: "Burger (Demo-Eintrag)", description: "Beispielartikel – bitte echten Namen und Preis bestätigen.", price: 990 },
      { id: "cherry-fries", name: "Pommes (Demo-Eintrag)", description: "Beispielartikel – bitte echten Namen und Preis bestätigen.", price: 390 },
      { id: "cherry-drink", name: "Getränk (Demo-Eintrag)", description: "Beispielartikel – bitte echten Namen und Preis bestätigen.", price: 250 }
    ]
  },
  schnitzel: {
    id: "schnitzel",
    name: "Schmitzel und mehr Mattersburg",
    description: "Speisekarte bitte vor dem Live-Start mit dem Restaurant bestätigen.",
    items: [
      { id: "schnitzel-classic", name: "Schnitzel (Demo-Eintrag)", description: "Beispielartikel – bitte echten Namen und Preis bestätigen.", price: 1290 },
      { id: "schnitzel-fries", name: "Pommes (Demo-Eintrag)", description: "Beispielartikel – bitte echten Namen und Preis bestätigen.", price: 390 },
      { id: "schnitzel-drink", name: "Getränk (Demo-Eintrag)", description: "Beispielartikel – bitte echten Namen und Preis bestätigen.", price: 250 }
    ]
  }
};

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: "30kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: DATA_DIR }),
  name: "mattersburg.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: "Bitte zuerst als Administrator anmelden." });
}
function euros(cents) { return (cents / 100).toLocaleString("de-AT", { style: "currency", currency: "EUR" }); }

app.get("/api/menu", (req, res) => {
  res.json(Object.values(menus));
});

app.post("/api/orders", orderLimiter, async (req, res) => {
  const { name, restaurantId, items, note } = req.body || {};
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    return res.status(400).json({ error: "Bitte gib einen Namen mit 2 bis 80 Zeichen ein." });
  }
  if (!menus[restaurantId] || !Array.isArray(items) || items.length < 1 || items.length > 30) {
    return res.status(400).json({ error: "Bitte wähle ein Restaurant und mindestens einen Artikel." });
  }
  if (typeof note !== "undefined" && (typeof note !== "string" || note.length > 500)) {
    return res.status(400).json({ error: "Die Anmerkung darf höchstens 500 Zeichen lang sein." });
  }

  const menu = menus[restaurantId];
  const normalized = [];
  let total = 0;
  for (const entry of items) {
    const product = menu.items.find(p => p.id === entry.id);
    const qty = Number(entry.quantity);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      return res.status(400).json({ error: "Ein Artikel oder die Menge ist ungültig." });
    }
    normalized.push({ id: product.id, name: product.name, quantity: qty, unitPriceCents: product.price, lineTotalCents: product.price * qty });
    total += product.price * qty;
  }

  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO orders (created_at, customer_name, restaurant_id, restaurant_name, items_json, total_cents, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(createdAt, name.trim(), restaurantId, menu.name, JSON.stringify(normalized), total, (note || "").trim());

  const order = {
    id: Number(result.lastInsertRowid),
    createdAt,
    name: name.trim(),
    restaurant: menu.name,
    items: normalized,
    totalCents: total,
    total: euros(total),
    note: (note || "").trim(),
    payment: "Vor Ort"
  };

  const whatsappSent = await sendWhatsAppTemplate(order);
  res.status(201).json({
    message: "Bestellung gespeichert. Bezahlt wird ausschließlich vor Ort.",
    orderId: order.id,
    total: order.total,
    whatsappSent
  });
});

async function sendWhatsAppTemplate(order) {
  const { WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_TO, WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANGUAGE } = process.env;
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN || !WHATSAPP_TO || !WHATSAPP_TEMPLATE_NAME) return false;

  const itemText = order.items.map(i => `${i.quantity}x ${i.name}`).join(", ").slice(0, 900);
  const payload = {
    messaging_product: "whatsapp",
    to: WHATSAPP_TO,
    type: "template",
    template: {
      name: WHATSAPP_TEMPLATE_NAME,
      language: { code: WHATSAPP_TEMPLATE_LANGUAGE || "de" },
      components: [{
        type: "body",
        parameters: [
          { type: "text", text: String(order.id) },
          { type: "text", text: order.name.slice(0, 80) },
          { type: "text", text: order.restaurant.slice(0, 100) },
          { type: "text", text: itemText || "Keine Artikel" },
          { type: "text", text: order.total },
          { type: "text", text: "Bezahlung vor Ort" }
        ]
      }]
    }
  };
  try {
    const response = await fetch(`https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) console.error("WhatsApp-Vorlage konnte nicht gesendet werden:", await response.text());
    return response.ok;
  } catch (err) {
    console.error("WhatsApp-Fehler:", err.message);
    return false;
  }
}

app.post("/api/admin/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const userOk = typeof username === "string" && username === process.env.ADMIN_USERNAME;
  const passOk = typeof password === "string" && await bcrypt.compare(password, await bcrypt.hash(process.env.ADMIN_PASSWORD, 10));
  // Compare to a hash derived from the configured secret; never store credentials in the browser.
  if (!userOk || !passOk) return res.status(401).json({ error: "Benutzername oder Passwort stimmt nicht." });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Anmeldung fehlgeschlagen." });
    req.session.isAdmin = true;
    res.json({ ok: true });
  });
});
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 500").all();
  res.json(rows.map(row => ({
    id: row.id,
    createdAt: row.created_at,
    name: row.customer_name,
    restaurant: row.restaurant_name,
    items: JSON.parse(row.items_json),
    total: euros(row.total_cents),
    note: row.note,
    status: row.status,
    payment: "Vor Ort"
  })));
});
app.patch("/api/admin/orders/:id", requireAdmin, (req, res) => {
  const allowed = ["Neu", "In Bearbeitung", "Erledigt", "Storniert"];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: "Ungültiger Status." });
  const result = db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(req.body.status, Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: "Bestellung nicht gefunden." });
  res.json({ ok: true });
});
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Bestellseite läuft auf http://localhost:${PORT}`));
