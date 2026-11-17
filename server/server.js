import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firebaseDelete, firebaseEnabled, firebaseGet, firebaseInfo, firebaseList, firebaseUpsert } from './firebase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'lumiere.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','admin','owner')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    compare_at_cents INTEGER,
    shade TEXT,
    image TEXT,
    description TEXT,
    inventory INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'processing',
    total_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
    discount_value INTEGER NOT NULL,
    min_order_cents INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS store_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
const defaultSettings = { store_name: 'Danus Cosmetics', store_email: 'hello@lumiere.example', currency: 'INR', low_stock_alerts: 'true', customer_reviews: 'true', upi_id: '' };
const saveSetting = db.prepare('INSERT OR IGNORE INTO store_settings (key,value) VALUES (?,?)');
Object.entries(defaultSettings).forEach(([key, value]) => saveSetting.run(key, value));
const productColumns = db.prepare('PRAGMA table_info(products)').all().map(column => column.name);
if (!productColumns.includes('description')) db.exec('ALTER TABLE products ADD COLUMN description TEXT');
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(column => column.name);
const orderMigrations = {
  payment_method: "TEXT NOT NULL DEFAULT 'cod'",
  payment_status: "TEXT NOT NULL DEFAULT 'pending'",
  transaction_number: 'TEXT',
  location_lat: 'REAL',
  location_lng: 'REAL',
  shipping_address: 'TEXT',
  contact_phone: 'TEXT',
  subtotal_cents: 'INTEGER NOT NULL DEFAULT 0',
  discount_cents: 'INTEGER NOT NULL DEFAULT 0',
  payment_note: 'TEXT',
  payment_verified_at: 'TEXT',
  payment_verified_by: 'INTEGER',
  status_note: 'TEXT',
  status_updated_at: 'TEXT'
  ,coupon_code: 'TEXT'
  ,coupon_discount_cents: 'INTEGER NOT NULL DEFAULT 0'
};
for (const [column, definition] of Object.entries(orderMigrations)) if (!orderColumns.includes(column)) db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);

const adminEmail = process.env.DEMO_ADMIN_EMAIL || 'admin@lumiere.test';
const adminPassword = process.env.DEMO_ADMIN_PASSWORD || 'ChangeMe123!';
const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
if (!existingAdmin) {
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run('Amelia Kim', adminEmail, bcrypt.hashSync(adminPassword, 12), 'owner');
}
const productCount = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
if (!productCount) {
  const seed = db.prepare('INSERT INTO products (name,type,price_cents,compare_at_cents,shade,image,inventory) VALUES (?,?,?,?,?,?,?)');
  const rows = [
    ['Cloud Skin Tint','Complexion',3200,3800,'12 shades','https://images.unsplash.com/photo-1631214524020-7e18db9d6f1f?auto=format&fit=crop&w=900&q=80',42],
    ['Rosewater Cream Blush','Cheeks',2400,2800,'6 shades','https://images.unsplash.com/photo-1583241800698-e8ab01830a9a?auto=format&fit=crop&w=900&q=80',26],
    ['Soft Focus Bronzer','Complexion',2900,null,'4 shades','https://images.unsplash.com/photo-1596704017254-9b121068fb31?auto=format&fit=crop&w=900&q=80',31],
    ['Satin Lip Veil','Lips',2200,2600,'8 shades','https://images.unsplash.com/photo-1586495777744-4413f21062fa?auto=format&fit=crop&w=900&q=80',12],
    ['Lustre Balm Highlighter','Glow',2600,null,'3 shades','https://images.unsplash.com/photo-1607602132700-068a6c7e8e1d?auto=format&fit=crop&w=900&q=80',8],
    ['Daily Dew Serum','Skincare',3600,null,'30 ml','https://images.unsplash.com/photo-1611930022073-b7a4ba5fcccd?auto=format&fit=crop&w=900&q=80',18]
  ];
  const transaction = db.transaction(() => rows.forEach(row => seed.run(...row)));
  transaction();
}
// When Firebase is configured, mirror the local seed data into Firestore on startup.
const indiaPriceMigration = new Map([['Cloud Skin Tint', 249900], ['Rosewater Cream Blush', 189900], ['Soft Focus Bronzer', 229900], ['Satin Lip Veil', 159900], ['Lustre Balm Highlighter', 199900], ['Daily Dew Serum', 269900]]);
for (const [name, price] of indiaPriceMigration) db.prepare('UPDATE products SET price_cents = ? WHERE name = ? AND price_cents IN (2200,2400,2600,2900,3200,3600)').run(price, name);
Promise.all(db.prepare('SELECT * FROM products').all().map(product => firebaseUpsert('products', product.id, product))).catch(error => console.warn(`Firebase seed sync skipped: ${error.message}`));

async function loadFirestoreData() {
  if (!firebaseEnabled()) return;
  const [remoteProducts, remoteSettings] = await Promise.all([
    firebaseList('products'),
    firebaseGet('settings', 'store')
  ]);
  if (remoteProducts.length) {
    const upsert = db.prepare(`INSERT INTO products (id,name,type,price_cents,compare_at_cents,shade,image,description,inventory,active,created_at)
      VALUES (@id,@name,@type,@price_cents,@compare_at_cents,@shade,@image,@description,@inventory,@active,COALESCE(@created_at,CURRENT_TIMESTAMP))
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,price_cents=excluded.price_cents,compare_at_cents=excluded.compare_at_cents,shade=excluded.shade,image=excluded.image,description=excluded.description,inventory=excluded.inventory,active=excluded.active`);
    const syncProducts = db.transaction(rows => rows.forEach(product => upsert.run({
      id: Number(product.id), name: product.name || 'Untitled product', type: product.type || 'Skincare',
      price_cents: Number(product.price_cents || 0), compare_at_cents: product.compare_at_cents == null ? null : Number(product.compare_at_cents),
      shade: product.shade || '', image: product.image || '', description: product.description || '', inventory: Number(product.inventory || 0),
      active: product.active === false || product.active === 0 ? 0 : 1, created_at: product.created_at || null
    })));
    syncProducts(remoteProducts);
    console.log(`Loaded ${remoteProducts.length} products from Firestore`);
  }
  if (remoteSettings) {
    const saveRemoteSetting = db.prepare('INSERT INTO store_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP');
    const syncSettings = db.transaction(settings => Object.entries(settings).filter(([key]) => key !== 'id' && key !== 'syncedAt').forEach(([key, value]) => saveRemoteSetting.run(key, String(value ?? ''))));
    syncSettings(remoteSettings);
  }
}

await loadFirestoreData().catch(error => console.warn(`Firestore read sync skipped: ${error.message}`));
// Repair legacy MRP values that were imported as rupees instead of cents.
const legacyMrpRows = db.prepare('SELECT * FROM products WHERE price_cents > 10000 AND compare_at_cents > 0 AND compare_at_cents < 10000').all();
if (legacyMrpRows.length) {
  db.prepare('UPDATE products SET compare_at_cents = compare_at_cents * 100 WHERE price_cents > 10000 AND compare_at_cents > 0 AND compare_at_cents < 10000').run();
  await Promise.all(legacyMrpRows.map(row => firebaseUpsert('products', row.id, db.prepare('SELECT * FROM products WHERE id = ?').get(row.id))));
}

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store, max-age=0'); next(); });
app.get('/', (_req, res) => res.json({ service: 'Lumière Cosmetics API', status: 'ok', storefront: 'https://mywebsite-eo3.pages.dev' }));
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

const signToken = user => jwt.sign({ sub: user.id, role: user.role, email: user.email, name: user.name }, process.env.JWT_SECRET || 'local-dev-only-change-this', { expiresIn: '8h' });
const auth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET || 'local-dev-only-change-this'); next(); }
  catch { return res.status(401).json({ error: 'Session expired. Please sign in again.' }); }
};
const role = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Insufficient permissions.' });

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'lumiere-api', database: firebaseEnabled() ? 'firestore' : 'sqlite-fallback' }));
app.get('/api/storage', (_req, res) => res.json(firebaseInfo()));
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password.' });
  await firebaseUpsert('users', user.id, { name: user.name, email: user.email.toLowerCase(), role: user.role, createdAt: user.created_at });
  res.json({ token: signToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: 'Name, email, and a password of at least 8 characters are required.' });
  const normalizedEmail = email.trim().toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail)) return res.status(409).json({ error: 'An account with this email already exists.' });
  const result = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)').run(name.trim(), normalizedEmail, bcrypt.hashSync(password, 12), 'customer');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  await firebaseUpsert('users', user.id, { name: user.name, email: user.email, role: user.role, createdAt: user.created_at });
  const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.status(201).json({ token: signToken(user), user: safeUser });
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));
app.post('/api/auth/logout', auth, (_req, res) => res.status(204).end());

app.post('/api/orders', auth, async (req, res) => {
  const { items = [], paymentMethod = 'cod', transactionNumber = '', location, shippingAddress = '', contactPhone = '', couponCode = '' } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Your bag is empty.' });
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return res.status(400).json({ error: 'Please share your current location before placing the order.' });
  if (!['cod', 'phonepe'].includes(paymentMethod)) return res.status(400).json({ error: 'Select a valid payment method.' });
  if (paymentMethod === 'phonepe' && !String(transactionNumber).trim()) return res.status(400).json({ error: 'Enter your PhonePe / UPI transaction number for verification.' });
  const requested = items.map(item => ({ productId: Number(item.productId), quantity: Math.max(1, Number(item.quantity || 1)) }));
  const getProduct = db.prepare('SELECT id,name,price_cents,inventory FROM products WHERE id = ? AND active = 1');
  const selected = requested.map(item => ({ ...item, product: getProduct.get(item.productId) }));
  const missing = selected.find(item => !item.product || item.product.inventory < item.quantity);
  if (missing) return res.status(409).json({ error: missing.product ? `${missing.product.name} does not have enough stock.` : 'A product in your bag is no longer available.' });
  const subtotalCents = selected.reduce((sum, item) => sum + item.product.price_cents * item.quantity, 0);
  let couponDiscountCents = 0; let appliedCoupon = null;
  if (couponCode) {
    appliedCoupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(String(couponCode).trim().toUpperCase());
    if (!appliedCoupon) return res.status(400).json({ error: 'That coupon is not active or does not exist.' });
    if (subtotalCents < appliedCoupon.min_order_cents) return res.status(400).json({ error: `This coupon requires a minimum order of ₹${Math.round(appliedCoupon.min_order_cents / 100).toLocaleString('en-IN')}.` });
    couponDiscountCents = appliedCoupon.discount_type === 'percent' ? Math.round(subtotalCents * appliedCoupon.discount_value / 100) : appliedCoupon.discount_value;
  }
  const phonepeDiscountCents = paymentMethod === 'phonepe' ? Math.round(subtotalCents * 0.05) : 0;
  const discountCents = Math.min(subtotalCents, couponDiscountCents + phonepeDiscountCents);
  const totalCents = subtotalCents - discountCents;
  const createOrder = db.transaction(() => {
    const paymentStatus = paymentMethod === 'phonepe' ? 'needs_verification' : 'cod_pending';
    const order = db.prepare("INSERT INTO orders (user_id,status,total_cents,payment_method,payment_status,transaction_number,location_lat,location_lng,shipping_address,contact_phone,subtotal_cents,discount_cents,coupon_code,coupon_discount_cents,payment_note) VALUES (?, 'processing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(req.user.sub, totalCents, paymentMethod, paymentStatus, String(transactionNumber).trim() || null, location.lat, location.lng, shippingAddress, contactPhone, subtotalCents, discountCents, appliedCoupon?.code || null, couponDiscountCents, paymentMethod === 'phonepe' ? 'Payment submitted by customer; admin verification required.' : 'Cash on delivery selected.');
    if (appliedCoupon) db.prepare('UPDATE coupons SET usage_count = usage_count + 1 WHERE id = ?').run(appliedCoupon.id);
    const addItem = db.prepare('INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price_cents) VALUES (?,?,?,?,?)');
    const reduceStock = db.prepare('UPDATE products SET inventory = inventory - ? WHERE id = ?');
    selected.forEach(item => { addItem.run(order.lastInsertRowid, item.product.id, item.product.name, item.quantity, item.product.price_cents); reduceStock.run(item.quantity, item.product.id); });
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.lastInsertRowid);
  });
  const order = createOrder();
  const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  await firebaseUpsert('orders', order.id, { ...order, items: orderItems, currency: 'INR' });
  res.status(201).json({ order: { ...order, items: orderItems, currency: 'INR' } });
});
app.get('/api/orders', auth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.user.sub).map(order => ({ ...order, currency: 'INR', items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id) }));
  res.json({ orders });
});
app.get('/api/orders/:id', auth, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.sub);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order: { ...order, currency: 'INR', items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id) } });
});
app.patch('/api/admin/orders/:id/payment', auth, role('admin', 'owner'), async (req, res) => {
  const { status, note = '' } = req.body || {};
  if (!['verified', 'rejected'].includes(status)) return res.status(400).json({ error: 'Payment status must be verified or rejected.' });
  const result = db.prepare("UPDATE orders SET payment_status = ?, payment_note = ?, payment_verified_at = CURRENT_TIMESTAMP, payment_verified_by = ?, status = CASE WHEN ? = 'verified' THEN 'processing' ELSE 'payment_review' END WHERE id = ?").run(status, note || (status === 'verified' ? 'Payment verified by admin.' : 'Payment could not be verified.'), req.user.sub, status, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Order not found.' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  await firebaseUpsert('orders', order.id, { ...order, currency: 'INR', paymentStatus: status });
  res.json({ order });
});
app.get('/api/admin/orders/:id', auth, role('admin', 'owner'), (req, res) => {
  const order = db.prepare('SELECT orders.*, users.name, users.email FROM orders LEFT JOIN users ON users.id = orders.user_id WHERE orders.id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order: { ...order, currency: 'INR', items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id) } });
});
app.patch('/api/admin/orders/:id/status', auth, role('admin', 'owner'), async (req, res) => {
  const allowed = ['processing', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'returned'];
  const { status, note = '' } = req.body || {};
  if (!allowed.includes(status)) return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}.` });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status === 'delivered' || order.status === 'cancelled' || order.status === 'returned') return res.status(409).json({ error: 'This order is already in a final state.' });
  if (order.payment_method === 'phonepe' && order.payment_status !== 'verified' && ['confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered'].includes(status)) return res.status(409).json({ error: 'Verify the PhonePe payment before fulfillment can continue.' });
  const transitions = { processing: ['confirmed', 'cancelled'], confirmed: ['packed', 'cancelled'], packed: ['shipped', 'cancelled'], shipped: ['out_for_delivery', 'returned'], out_for_delivery: ['delivered', 'returned'], delivered: ['returned'], payment_review: ['processing', 'cancelled'] };
  if (status !== order.status && !(transitions[order.status] || []).includes(status)) return res.status(409).json({ error: `Cannot move an order from ${order.status} to ${status}.` });
  const result = db.prepare('UPDATE orders SET status = ?, status_note = ?, status_updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, note || `Order status updated to ${status}.`, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Order not found.' });
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  await firebaseUpsert('orders', updated.id, { ...updated, currency: 'INR' });
  res.json({ order: updated });
});

app.get('/api/products', (_req, res) => {
  const products = db.prepare('SELECT id,name,type,price_cents,compare_at_cents,shade,image,description,inventory FROM products WHERE active = 1 ORDER BY id').all();
  res.json({ products });
});
app.get('/api/store-settings', (_req, res) => {
  const rows = db.prepare("SELECT key,value FROM store_settings WHERE key IN ('store_name','currency','upi_id')").all();
  res.json({ settings: Object.fromEntries(rows.map(row => [row.key, row.value])) });
});
app.get('/api/promotions', (_req, res) => res.json({ coupons: db.prepare("SELECT code,discount_type,discount_value,min_order_cents FROM coupons WHERE active = 1 ORDER BY created_at DESC").all() }));
app.get('/api/admin/products', auth, role('admin', 'owner'), (_req, res) => res.json({ products: db.prepare('SELECT * FROM products ORDER BY created_at DESC').all() }));
app.post('/api/admin/products', auth, role('admin', 'owner'), async (req, res) => {
  const { name, type, priceCents, compareAtCents = null, shade = '', image = '', description = '', inventory = 0 } = req.body || {};
  if (!name || !type || !Number.isInteger(priceCents)) return res.status(400).json({ error: 'name, type, and integer priceCents are required.' });
  const result = db.prepare('INSERT INTO products (name,type,price_cents,compare_at_cents,shade,image,description,inventory) VALUES (?,?,?,?,?,?,?,?)').run(name, type, priceCents, compareAtCents, shade, image, description, inventory);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
  await firebaseUpsert('products', product.id, product);
  res.status(201).json({ product });
});
app.patch('/api/admin/products/:id', auth, role('admin', 'owner'), async (req, res) => {
  const { name, type, priceCents, compareAtCents, inventory, shade, image, description, active } = req.body || {};
  const result = db.prepare('UPDATE products SET name = COALESCE(?,name), type = COALESCE(?,type), price_cents = COALESCE(?,price_cents), compare_at_cents = COALESCE(?,compare_at_cents), inventory = COALESCE(?,inventory), shade = COALESCE(?,shade), image = COALESCE(?,image), description = COALESCE(?,description), active = COALESCE(?,active) WHERE id = ?').run(name, type, priceCents, compareAtCents, inventory, shade, image, description, active, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Product not found.' });
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  await firebaseUpsert('products', product.id, product);
  res.json({ product });
});
app.delete('/api/admin/products/:id', auth, role('owner'), async (req, res) => {
  const result = db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Product not found.' });
  await firebaseDelete('products', req.params.id);
  res.status(204).end();
});
app.get('/api/admin/customers', auth, role('admin', 'owner'), (_req, res) => res.json({ customers: db.prepare("SELECT id,name,email,role,created_at FROM users WHERE role = 'customer' ORDER BY created_at DESC").all() }));
app.get('/api/admin/customers/:id', auth, role('admin', 'owner'), (req, res) => { const customer = db.prepare("SELECT id,name,email,role,created_at FROM users WHERE id = ? AND role = 'customer'").get(req.params.id); if (!customer) return res.status(404).json({ error: 'Customer not found.' }); const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(customer.id).map(order => ({ ...order, items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id) })); res.json({ customer, orders }); });
app.get('/api/admin/coupons', auth, role('admin', 'owner'), (_req, res) => res.json({ coupons: db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all() }));
app.post('/api/admin/coupons', auth, role('admin', 'owner'), async (req, res) => { const { code, discountType = 'percent', discountValue, minOrderCents = 0 } = req.body || {}; const normalized = String(code || '').trim().toUpperCase(); if (!normalized || !['percent','fixed'].includes(discountType) || !Number.isInteger(Number(discountValue))) return res.status(400).json({ error: 'Code, discount type, and integer discount value are required.' }); try { const result = db.prepare('INSERT INTO coupons (code,discount_type,discount_value,min_order_cents) VALUES (?,?,?,?)').run(normalized, discountType, Number(discountValue), Number(minOrderCents)); const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(result.lastInsertRowid); await firebaseUpsert('coupons', coupon.id, coupon); res.status(201).json({ coupon }); } catch { res.status(409).json({ error: 'That coupon code already exists.' }); } });
app.patch('/api/admin/coupons/:id', auth, role('admin', 'owner'), async (req, res) => { const result = db.prepare('UPDATE coupons SET active = COALESCE(?,active) WHERE id = ?').run(req.body?.active, req.params.id); if (!result.changes) return res.status(404).json({ error: 'Coupon not found.' }); const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id); await firebaseUpsert('coupons', coupon.id, coupon); res.json({ coupon }); });
app.get('/api/admin/settings', auth, role('admin', 'owner'), (_req, res) => { const rows = db.prepare('SELECT key,value FROM store_settings').all(); res.json({ settings: Object.fromEntries(rows.map(row => [row.key, row.value])) }); });
app.patch('/api/admin/settings', auth, role('admin', 'owner'), async (req, res) => { const allowed = Object.keys(defaultSettings); const update = db.prepare('INSERT INTO store_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'); const entries = Object.entries(req.body || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined).map(([key, value]) => [key, String(value)]); const transaction = db.transaction(() => entries.forEach(([key, value]) => update.run(key, value))); transaction(); const settings = Object.fromEntries(db.prepare('SELECT key,value FROM store_settings').all().map(row => [row.key, row.value])); await firebaseUpsert('settings', 'store', settings); res.json({ settings }); });
app.get('/api/admin/orders', auth, role('admin', 'owner'), (_req, res) => res.json({ orders: db.prepare('SELECT orders.*, users.name, users.email FROM orders LEFT JOIN users ON users.id = orders.user_id ORDER BY orders.created_at DESC').all() }));
app.get('/api/admin/overview', auth, role('admin', 'owner'), (_req, res) => {
  const products = db.prepare('SELECT COUNT(*) AS count FROM products WHERE active = 1').get().count;
  const customers = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'customer'").get().count;
  const orders = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(total_cents),0) AS revenue FROM orders').get();
  res.json({ metrics: { products, customers, orders: orders.count, revenueCents: orders.revenue } });
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Unexpected server error.' }); });
const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`Lumière API listening on http://127.0.0.1:${port}`));
