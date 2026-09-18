const express = require("express");
const session = require("express-session");
const Razorpay = require("razorpay");
const dotenv = require("dotenv");
const multer = require("multer");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- DATABASE ----------------
const db = new Database("store.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL,
    file TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    download_token TEXT UNIQUE,
    status TEXT DEFAULT 'created',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ---------------- UPLOAD FOLDER ----------------
const uploadDir = path.join(__dirname, "uploads", "xml");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safeName);
  }
});

const upload = multer({
  storage,
  fileFilter: function (req, file, cb) {
    if (path.extname(file.originalname).toLowerCase() !== ".xml") {
      return cb(new Error("Only XML files are allowed"));
    }
    cb(null, true);
  }
});

// ---------------- RAZORPAY ----------------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

// ---------------- ADMIN AUTH ----------------
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }

  res.status(401).json({
    error: "Unauthorized"
  });
}

// ---------------- PRODUCTS ----------------
app.get("/api/products", (req, res) => {
  const products = db
    .prepare(
      `SELECT id, name, description, price, created_at
       FROM products
       ORDER BY id DESC`
    )
    .all();

  res.json(products);
});

// ---------------- CREATE RAZORPAY ORDER ----------------
app.post("/api/create-order", async (req, res) => {
  try {
    const { productId } = req.body;

    const product = db
      .prepare("SELECT * FROM products WHERE id = ?")
      .get(productId);

    if (!product) {
      return res.status(404).json({
        error: "Product not found"
      });
    }

    const order = await razorpay.orders.create({
      amount: product.price * 100,
      currency: "INR",
      receipt: "nobeditz_" + Date.now()
    });

    const token = crypto.randomBytes(32).toString("hex");

    db.prepare(`
      INSERT INTO orders
      (product_id, razorpay_order_id, download_token, status)
      VALUES (?, ?, ?, ?)
    `).run(
      product.id,
      order.id,
      token,
      "created"
    );

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not create payment order"
    });
  }
});

// ---------------- VERIFY PAYMENT ----------------
app.post("/api/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(
        razorpay_order_id + "|" + razorpay_payment_id
      )
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: "Invalid payment signature"
      });
    }

    const order = db
      .prepare(
        `SELECT * FROM orders
         WHERE razorpay_order_id = ?`
      )
      .get(razorpay_order_id);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: "Order not found"
      });
    }

    db.prepare(`
      UPDATE orders
      SET razorpay_payment_id = ?,
          status = 'paid'
      WHERE razorpay_order_id = ?
    `).run(
      razorpay_payment_id,
      razorpay_order_id
    );

    res.json({
      success: true,
      downloadToken: order.download_token
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: "Payment verification failed"
    });
  }
});

// ---------------- DOWNLOAD XML ----------------
app.get("/api/download/:token", (req, res) => {
  try {
    const order = db
      .prepare(`
        SELECT orders.*, products.file, products.name
        FROM orders
        JOIN products
        ON orders.product_id = products.id
        WHERE orders.download_token = ?
        AND orders.status = 'paid'
      `)
      .get(req.params.token);

    if (!order) {
      return res.status(404).send("Invalid or expired download link.");
    }

    const filePath = path.join(uploadDir, order.file);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send("File not found.");
    }

    res.download(filePath, order.name + ".xml");

  } catch (error) {
    console.error(error);
    res.status(500).send("Download failed.");
  }
});

// ---------------- ADMIN LOGIN ----------------
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.admin = true;

    return res.json({
      success: true
    });
  }

  res.status(401).json({
    success: false,
    error: "Invalid username or password"
  });
});

// ---------------- ADMIN LOGOUT ----------------
app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({
      success: true
    });
  });
});

// ---------------- ADMIN PRODUCTS ----------------
app.get("/api/admin/products", requireAdmin, (req, res) => {
  const products = db
    .prepare("SELECT * FROM products ORDER BY id DESC")
    .all();

  res.json(products);
});

app.post(
  "/api/admin/products",
  requireAdmin,
  upload.single("xml"),
  (req, res) => {
    try {
      const {
        name,
        description,
        price
      } = req.body;

      if (!req.file) {
        return res.status(400).json({
          error: "XML file is required"
        });
      }

      if (!name || !price) {
        return res.status(400).json({
          error: "Name and price are required"
        });
      }

      const result = db
        .prepare(`
          INSERT INTO products
          (name, description, price, file)
          VALUES (?, ?, ?, ?)
        `)
        .run(
          name,
          description || "",
          Number(price),
          req.file.filename
        );

      res.json({
        success: true,
        productId: result.lastInsertRowid
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Product upload failed"
      });
    }
  }
);

// ---------------- DELETE PRODUCT ----------------
app.delete(
  "/api/admin/products/:id",
  requireAdmin,
  (req, res) => {
    const product = db
      .prepare("SELECT * FROM products WHERE id = ?")
      .get(req.params.id);

    if (!product) {
      return res.status(404).json({
        error: "Product not found"
      });
    }

    const filePath = path.join(
      uploadDir,
      product.file
    );

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    db.prepare(
      "DELETE FROM products WHERE id = ?"
    ).run(req.params.id);

    res.json({
      success: true
    });
  }
);

// ---------------- ADMIN ORDERS ----------------
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const orders = db
    .prepare(`
      SELECT
        orders.*,
        products.name AS product_name
      FROM orders
      LEFT JOIN products
      ON orders.product_id = products.id
      ORDER BY orders.id DESC
    `)
    .all();

  res.json(orders);
});

// ---------------- RAZORPAY WEBHOOK ----------------
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      const signature = req.headers["x-razorpay-signature"];

      const expectedSignature = crypto
        .createHmac(
          "sha256",
          process.env.RAZORPAY_WEBHOOK_SECRET
        )
        .update(req.body)
        .digest("hex");

      if (signature !== expectedSignature) {
        return res.status(400).send("Invalid signature");
      }

      const event = JSON.parse(req.body.toString());

      if (event.event === "payment.captured") {
        const payment =
          event.payload.payment.entity;

        db.prepare(`
          UPDATE orders
          SET razorpay_payment_id = ?,
              status = 'paid'
          WHERE razorpay_order_id = ?
        `).run(
          payment.id,
          payment.order_id
        );
      }

      res.json({
        received: true
      });

    } catch (error) {
      console.error(error);
      res.status(500).send("Webhook error");
    }
  }
);

// ---------------- ERROR HANDLER ----------------
app.use((error, req, res, next) => {
  console.error(error);

  res.status(500).json({
    error: error.message || "Server error"
  });
});

// ---------------- START SERVER ----------------
app.listen(PORT, () => {
  console.log(
    `NOBEDITz Store running on port ${PORT}`
  );
});
