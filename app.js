const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const crypto = require("crypto");
const sharp = require("sharp");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5001;
let currentInterval = 30;

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------
const REQUIRED_ENV = [
  "SECRET_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_URL",
];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const SECRET_KEY = Buffer.from(process.env.SECRET_KEY); // 32 bytes for AES-256
if (SECRET_KEY.length !== 32) {
  console.error(`❌ SECRET_KEY must be 32 bytes, got ${SECRET_KEY.length}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// R2 (S3-compatible) client
// ---------------------------------------------------------------------------
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL.replace(/\/$/, ""); // strip trailing slash
const LOGS_KEY = "logs.json"; // persisted log index, stored as an object in the same bucket

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB raw upload cap
  fileFilter: (req, file, cb) => {
    // if (!file.mimetype.startsWith("image/")) {
    //   return cb(new Error("Only image files are allowed"));
    // }

    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error(`Only image files are allowed (got: ${file.mimetype})`));
    }

    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// In-memory log cache (persisted to R2 as logs.json)
// ---------------------------------------------------------------------------
let logs = []; // { imageUrl, key, usage, timestamp }

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function loadLogsFromR2() {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: LOGS_KEY }));
    const bodyText = await streamToString(result.Body);
    logs = JSON.parse(bodyText);
    console.log(`✅ Loaded ${logs.length} logs from R2`);
  } catch (err) {
    if (err.name === "NoSuchKey") {
      console.log("ℹ️ No existing logs.json in R2 — starting fresh");
      logs = [];
    } else {
      console.error("⚠️ Failed to load logs.json from R2:", err.message);
      logs = [];
    }
  }
}

async function saveLogsToR2() {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: LOGS_KEY,
        Body: JSON.stringify(logs),
        ContentType: "application/json",
      })
    );
  } catch (err) {
    console.error("⚠️ Failed to save logs.json to R2:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------
function encryptData(data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", SECRET_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return { iv: iv.toString("hex"), data: encrypted.toString("hex") };
}

// ---------------------------------------------------------------------------
// R2 object helpers
// ---------------------------------------------------------------------------
async function uploadToR2(buffer, key, contentType = "image/jpeg") {
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return `${R2_PUBLIC_URL}/${key}`;
}

async function deleteFromR2(key) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (err) {
    console.error(`⚠️ Failed to delete R2 object "${key}":`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post("/api/interval", (req, res) => {
  try {
    const { interval } = req.body;
    const parsed = parseInt(interval, 10);

    if (isNaN(parsed) || parsed <= 0) {
      return res.status(400).json({ error: "Invalid interval value" });
    }

    currentInterval = parsed;
    fs.writeFileSync("interval.txt", currentInterval.toString());
    res.status(200).json({ message: "Interval updated", interval: currentInterval });
  } catch (err) {
    console.error("❌ /api/interval error:", err.message);
    res.status(500).json({ error: "Failed to update interval" });
  }
});

// ---------------------------------------------------------------------------
// Debug logging — prints what the client actually sends
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  console.log("\n========== Incoming Request ==========");
  console.log("Time:", new Date().toISOString());
  console.log("Method:", req.method);
  console.log("URL:", req.originalUrl);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  next();
});

app.post("/api/upload", upload.single("screenshot"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No screenshot file provided" });
    }

    const { timestamp } = req.body;
    if (!timestamp) {
      return res.status(400).json({ error: "Missing timestamp" });
    }

    let usage = {};
    try {
      usage = JSON.parse(req.body.usage || "{}");
    } catch (err) {
      return res.status(400).json({ error: "Invalid usage JSON" });
    }

    let compressedBuffer;
    try {
      compressedBuffer = await sharp(req.file.buffer)
        .resize({ width: 1280, withoutEnlargement: true })
        .jpeg({ quality: 65 })
        .toBuffer();
    } catch (err) {
      console.error("❌ Image compression failed:", err.message);
      return res.status(422).json({ error: "Failed to process image" });
    }

    const key = `screenshot_${Date.now()}.jpg`;

    let fileUrl;
    try {
      fileUrl = await uploadToR2(compressedBuffer, key);
    } catch (err) {
      console.error("❌ R2 upload failed:", err.message);
      return res.status(502).json({ error: "Failed to upload image to storage" });
    }

    logs.unshift({ imageUrl: fileUrl, key, usage, timestamp });

    if (logs.length > 100) {
      const removed = logs.pop();
      if (removed?.key) {
        await deleteFromR2(removed.key);
      }
    }

    await saveLogsToR2();

    res.status(200).json({ message: "Uploaded", imageUrl: fileUrl });
  } catch (err) {
    console.error("❌ /api/upload unexpected error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/logs", (req, res) => {
  try {
    const encrypted = encryptData(logs);
    res.json(encrypted);
  } catch (err) {
    console.error("❌ /api/logs error:", err.message);
    res.status(500).json({ error: "Failed to retrieve logs" });
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error("❌ Multer error:", err.message);
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    console.error("❌ Unhandled error:", err.message);
    return res.status(500).json({ error: "Something went wrong" });
  }
  next();
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function startServer() {
  await loadLogsFromR2();
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });
}

startServer();