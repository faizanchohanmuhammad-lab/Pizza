
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

let supabase;

function getDB() {
  if (!URL || !SERVICE_KEY) {
    throw new Error("Supabase environment variables are missing.");
  }

  if (!supabase) {
    supabase = createClient(URL, SERVICE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  return supabase;
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Please login first." });
  }

  if (!JWT_SECRET) {
    return res.status(500).json({ error: "JWT_SECRET is not configured." });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please login again." });
  }
}

function makeToken(tenant) {
  return jwt.sign(
    { id: tenant.id, email: tenant.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function productOutput(p) {
  return {
    _id: p.id,
    tenantId: p.tenant_id,
    name: p.name,
    category: p.category,
    price: Number(p.price),
    stock: p.stock,
    createdAt: p.created_at
  };
}

function orderOutput(o) {
  return {
    _id: o.id,
    tenantId: o.tenant_id,
    customerName: o.customer_name,
    customerPhone: o.customer_phone || "",
    items: o.items || [],
    total: Number(o.total),
    status: o.status,
    createdAt: o.created_at
  };
}

function handleDBError(error, res) {
  console.error("Database error:", error.message);
  return res.status(500).json({
    error: error.message || "Database operation failed."
  });
}

// Website homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check
app.get("/api/health", (req, res) => {
  try {
    getDB();
    res.json({ status: "ok", database: "configured", app: "PizzaPilot AI" });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

// Register a new business
app.post("/api/register", async (req, res) => {
  try {
    const db = getDB();

    const {
      businessName,
      businessType,
      ownerName,
      email,
      phone,
      password
    } = req.body;

    if (!businessName || !email || !password) {
      return res.status(400).json({
        error: "Business name, email and password are required."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters."
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const { data: existing, error: lookupError } = await db
      .from("tenants")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (existing) {
      return res.status(409).json({
        error: "This email is already registered."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data: tenant, error } = await db
      .from("tenants")
      .insert({
        business_name: businessName.trim(),
        business_type: businessType || "Restaurant",
        owner_name: ownerName || "",
        email: normalizedEmail,
        phone: phone || "",
        password_hash: passwordHash
      })
      .select("id,business_name,email")
      .single();

    if (error) throw error;

    res.status(201).json({
      token: makeToken({ id: tenant.id, email: tenant.email }),
      business: {
        id: tenant.id,
        businessName: tenant.business_name,
        email: tenant.email
      }
    });
  } catch (error) {
    handleDBError(error, res);
  }
});

// Business login
app.post("/api/login", async (req, res) => {
  try {
    const db = getDB();
    const email = (req.body.email || "").trim().toLowerCase();

    const { data: tenant, error } = await db
      .from("tenants")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (error) throw error;

    if (
      !tenant ||
      !(await bcrypt.compare(req.body.password || "", tenant.password_hash))
    ) {
      return res.status(401).json({
        error: "Incorrect email or password."
      });
    }

    res.json({
      token: makeToken(tenant),
      business: {
        id: tenant.id,
        businessName: tenant.business_name,
        email: tenant.email
      }
    });
  } catch (error) {
    handleDBError(error, res);
  }
});

// Current business profile
app.get("/api/me", auth, async (req, res) => {
  try {
    const db = getDB();

    const { data, error } = await db
      .from("tenants")
      .select("id,business_name,business_type,owner_name,email,phone,created_at")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;

    res.json({
      _id: data.id,
      businessName: data.business_name,
      businessType: data.business_type,
      ownerName: data.owner_name,
      email: data.email,
      phone: data.phone,
      createdAt: data.created_at
    });
  } catch (error) {
    handleDBError(error, res);
  }
});

// Dashboard statistics
app.get("/api/dashboard", auth, async (req, res) => {
  try {
    const db = getDB();
    const tenantId = req.user.id;

    const [productsResult, ordersResult] = await Promise.all([
      db.from("products")
        .select("id,stock", { count: "exact" })
        .eq("tenant_id", tenantId),

      db.from("orders")
        .select("total,status,customer_phone")
        .eq("tenant_id", tenantId)
    ]);

    if (productsResult.error) throw productsResult.error;
    if (ordersResult.error) throw ordersResult.error;

    const products = productsResult.data || [];
    const orders = ordersResult.data || [];

    const revenue = orders
      .filter(o => o.status !== "Cancelled")
      .reduce((sum, o) => sum + Number(o.total), 0);

    const customers = new Set(
      orders.map(o => o.customer_phone).filter(Boolean)
    );

    res.json({
      products: productsResult.count || 0,
      orders: orders.length,
      revenue,
      customers: customers.size,
      lowStock: products.filter(p => p.stock <= 5).length
    });
  } catch (error) {
    handleDBError(error, res);
  }
});

// List products
app.get("/api/products", auth, async (req, res) => {
  try {
    const db = getDB();

    const { data, error } = await db
      .from("products")
      .select("*")
      .eq("tenant_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data.map(productOutput));
  } catch (error) {
    handleDBError(error, res);
  }
});

// Add product
app.post("/api/products", auth, async (req, res) => {
  try {
    const db = getDB();
    const { name, category, price, stock } = req.body;

    if (
      !name ||
      !Number.isFinite(Number(price)) ||
      Number(price) < 0
    ) {
      return res.status(400).json({
        error: "Enter a product name and valid price."
      });
    }

    const stockValue = Number(stock || 0);

    if (!Number.isInteger(stockValue) || stockValue < 0) {
      return res.status(400).json({
        error: "Stock must be a non-negative whole number."
      });
    }

    const { data, error } = await db
      .from("products")
      .insert({
        tenant_id: req.user.id,
        name: name.trim(),
        category: category || "General",
        price: Number(price),
        stock: stockValue
      })
      .select("*")
      .single();

    if (error) throw error;

    res.status(201).json(productOutput(data));
  } catch (error) {
    handleDBError(error, res);
  }
});

// Delete product
app.delete("/api/products/:id", auth, async (req, res) => {
  try {
    const db = getDB();

    const { data, error } = await db
      .from("products")
      .delete()
      .eq("id", req.params.id)
      .eq("tenant_id", req.user.id)
      .select("id");

    if (error) throw error;

    if (!data || !data.length) {
      return res.status(404).json({ error: "Product not found." });
    }

    res.json({ message: "Product deleted." });
  } catch (error) {
    handleDBError(error, res);
  }
});

// Create order with stock validation in a database transaction
app.post("/api/orders", auth, async (req, res) => {
  try {
    const db = getDB();
    const { customerName, customerPhone, items } = req.body;

    if (!customerName || !Array.isArray(items) || !items.length) {
      return res.status(400).json({
        error: "Customer name and order items are required."
      });
    }

    const cleanItems = items.map(item => ({
      productId: item.productId,
      quantity: Number(item.quantity)
    }));

    if (cleanItems.some(i =>
      !i.productId || !Number.isInteger(i.quantity) || i.quantity < 1
    )) {
      return res.status(400).json({
        error: "Invalid product or quantity."
      });
    }

    const { data, error } = await db.rpc("create_business_order", {
      p_tenant_id: req.user.id,
      p_customer_name: customerName,
      p_customer_phone: customerPhone || "",
      p_items: cleanItems
    });

    if (error) throw error;

    res.status(201).json(orderOutput(data));
  } catch (error) {
    handleDBError(error, res);
  }
});

// List orders
app.get("/api/orders", auth, async (req, res) => {
  try {
    const db = getDB();

    const { data, error } = await db
      .from("orders")
      .select("*")
      .eq("tenant_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    res.json(data.map(orderOutput));
  } catch (error) {
    handleDBError(error, res);
  }
});

// Update order status
app.patch("/api/orders/:id/status", auth, async (req, res) => {
  try {
    const db = getDB();
    const allowed = ["Pending", "Preparing", "Completed", "Cancelled"];

    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: "Invalid order status." });
    }

    const { data, error } = await db
      .from("orders")
      .update({ status: req.body.status })
      .eq("id", req.params.id)
      .eq("tenant_id", req.user.id)
      .select("*")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({ error: "Order not found." });
    }

    res.json(orderOutput(data));
  } catch (error) {
    handleDBError(error, res);
  }
});

// Vercel and local server export
module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log("PizzaPilot AI running on port " + port);
  });
}
auij
moo CE
 n
