require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '../')));

// Configure multer for file uploads
const upload = multer({ 
  dest: "uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  // fileFilter is used to filter the files that are allowed to be uploaded
  fileFilter: (req, file, cb) => {
    // Allow common document types
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/x-icon',
      'image/vnd.microsoft.icon',
      'image/svg+xml',
      'image/heic',
      'image/heif'
    ];
    // If the file is allowed, call the callback with null and true
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only documents and images are allowed.'), false);
    }
  }
});

const TOKEN_URL = 'https://raw.githubusercontent.com/bibekchandsah/bin/main/bin.json';
const TOKEN_KEY = 'enctest';
const SHUFFLE_SEED = 42; // Use the same seed as used for encryption
let GITHUB_TOKEN = null;

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    t ^= t >>> 14;
    return (t >>> 0) / 4294967296;
  };
}

function generateShuffleOrder(length, seed) {
  const indices = [...Array(length).keys()];
  const rng = mulberry32(seed);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

function deterministicUnshuffle(shuffled, seed) {
  const indices = generateShuffleOrder(shuffled.length, seed);
  const result = new Array(shuffled.length);
  for (let i = 0; i < indices.length; i++) {
    result[i] = shuffled[indices[i]];
  }
  return result.join('');
}

async function fetchAndDecryptToken() {
  try {
    const response = await axios.get(TOKEN_URL);
    const encrypted = response.data[TOKEN_KEY];
    // console.log('Encrypted token:', encrypted);
    GITHUB_TOKEN = deterministicUnshuffle(encrypted, SHUFFLE_SEED);
    // console.log('GitHub token loaded and decrypted.', GITHUB_TOKEN);
  } catch (err) {
    console.error('Failed to fetch or decrypt GitHub token:', err.message);
    process.exit(1);
  }
}

(async () => {
  await fetchAndDecryptToken();
  // Ensure uploads directory exists
  if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
  }

  app.post("/upload", upload.single("document"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded." });
      }

      const filePath = req.file.path;
      const fileName = req.file.originalname;
      const uploadPath = `music/${fileName}`;
      const content = fs.readFileSync(filePath, { encoding: "base64" });

      // Validate environment variables
      if (!process.env.GITHUB_USER || !process.env.GITHUB_REPO) {
        throw new Error("GitHub configuration missing. Please check your environment variables.");
      }
      if (!GITHUB_TOKEN) {
        throw new Error("GitHub token not loaded.");
      }

      // Check if file exists to get its sha (for overwrite)
      let sha = undefined;
      try {
        const getResp = await axios.get(
          `https://api.github.com/repos/${process.env.GITHUB_USER}/${process.env.GITHUB_REPO}/contents/${encodeURIComponent(uploadPath)}?ref=${process.env.GITHUB_BRANCH || "main"}`,
          {
            headers: {
              Authorization: `token ${GITHUB_TOKEN}`,
              "Content-Type": "application/json"
            }
          }
        );
        if (getResp.data && getResp.data.sha) {
          sha = getResp.data.sha;
        }
      } catch (e) {
        // If 404, file does not exist, so sha remains undefined
        if (e.response && e.response.status !== 404) {
          throw e;
        }
      }

      const response = await axios.put(
        `https://api.github.com/repos/${process.env.GITHUB_USER}/${process.env.GITHUB_REPO}/contents/${encodeURIComponent(uploadPath)}`,
        {
          message: `Upload ${fileName}`,
          content: content,
          branch: process.env.GITHUB_BRANCH || "main",
          ...(sha ? { sha } : {})
        },
        {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            "Content-Type": "application/json"
          }
        }
      );

      // Clean up local file
      fs.unlinkSync(filePath);
      
      res.json({ 
        success: true, 
        message: "File uploaded successfully!",
        fileUrl: response.data.content.html_url
      });
    } catch (err) {
      console.error("Upload error:", err.response?.data || err.message);
      
      // Clean up file if it exists
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      let errorMessage = "Upload failed.";
      if (err.response?.status === 401) {
        errorMessage = "GitHub authentication failed. Please check your token.";
      } else if (err.response?.status === 404) {
        errorMessage = "GitHub repository not found. Please check your repository name.";
      } else if (err.message.includes("Invalid file type")) {
        errorMessage = err.message;
      } else if (err.response?.status === 409) {
        errorMessage = "File already exists and could not be overwritten.";
      }
      
      res.status(500).json({ success: false, message: errorMessage });
    }
  });

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ status: "OK", timestamp: new Date().toISOString() });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Upload endpoint: http://localhost:${PORT}/upload`);
  });
})();
