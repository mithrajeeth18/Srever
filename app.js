const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const crypto = require("crypto");
const sharp = require("sharp");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5001;
let currentInterval = 30;

// ---- Validate required env vars on startup ----
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

// ---- R2 (S3-compatible) client ----
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

app.use(cors());
app.use(express.json());

// ---- Multer: store in memory, not disk, since we upload to R2 ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB raw upload cap, safety net
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
});

let logs = []; // { imageUrl, usage, timestamp }

// ---- Encryption ----
function encryptData(data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", SECRET_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return { iv: iv.toString("hex"), data: encrypted.toString("hex") };
}

// ---- Upload a buffer to R2, returns public URL ----
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

// ---- Delete an object from R2 by its key ----
async function deleteFromR2(key) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (err) {
    console.error(`⚠️ Failed to delete R2 object "${key}":`, err.message);
    // not fatal — don't throw, just log
  }
}

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

    // Compress + resize before upload
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

    // Evict oldest log beyond 100, and clean up its R2 object
    if (logs.length > 100) {
      const removed = logs.pop();
      if (removed?.key) {
        await deleteFromR2(removed.key);
      }
    }

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

// ---- Multer / general error handler (must come after routes) ----
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

// ---- 404 ----
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ---- Process-level safety nets ----
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});