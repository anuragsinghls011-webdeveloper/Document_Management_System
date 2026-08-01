/**
 * ─── Cloud Storage Service ──────────────────────────────────────────────────
 *
 * Abstraction layer for uploading files to cloud providers (GCS, S3, Azure)
 * or falling back to local disk storage. Uses REST APIs directly via fetch()
 * to avoid heavy SDK dependencies.
 *
 * Credentials are encrypted at rest using AES-256-CBC with JWT_SECRET.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const logger = require("../config/logger").createChildLogger("StorageService");
const StorageConfig = require("../models/storageConfig.model");

// ─── Encryption / Decryption Helpers ────────────────────────────────────────

const ALGO = "aes-256-cbc";

function getEncryptionKey() {
  const secret = process.env.JWT_SECRET || "default-secret-key-change-me";
  // Derive a 32-byte key from the JWT secret
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, getEncryptionKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text) {
  if (!text || !text.includes(":")) return "";
  const [ivHex, encryptedHex] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(ALGO, getEncryptionKey(), iv);
  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ─── GCS Upload (REST API) ──────────────────────────────────────────────────

async function getGCSAccessToken(credentialsJson) {
  const creds = JSON.parse(credentialsJson);
  const now = Math.floor(Date.now() / 1000);

  // Build JWT for service account authentication
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/devstorage.read_write",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })).toString("base64url");

  const signInput = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signInput);
  const signature = sign.sign(creds.private_key, "base64url");
  const jwt = `${signInput}.${signature}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`GCS auth failed: ${resp.status} ${errBody}`);
  }

  const data = await resp.json();
  return data.access_token;
}

async function uploadToGCS(filePath, fileName, config) {
  const credentials = decrypt(config.gcs.credentials);
  const accessToken = await getGCSAccessToken(credentials);
  const bucket = config.gcs.bucketName;
  const objectName = `documents/${Date.now()}-${fileName}`;

  const fileBuffer = await fs.promises.readFile(filePath);
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream"
    },
    body: fileBuffer
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`GCS upload failed: ${resp.status} ${errBody}`);
  }

  const data = await resp.json();
  return {
    provider: "gcs",
    url: `https://storage.googleapis.com/${bucket}/${objectName}`,
    path: objectName,
    metadata: data
  };
}

async function testGCS(config) {
  const credentials = decrypt(config.gcs.credentials);
  const accessToken = await getGCSAccessToken(credentials);
  const bucket = config.gcs.bucketName;

  const resp = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`GCS test failed: ${resp.status} ${errBody}`);
  }

  return { success: true, message: `Connected to bucket "${bucket}"` };
}

// ─── AWS S3 Upload (REST API with SigV4) ────────────────────────────────────

function hmacSHA256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmacSHA256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSHA256(kDate, region);
  const kService = hmacSHA256(kRegion, service);
  return hmacSHA256(kService, "aws4_request");
}

async function uploadToS3(filePath, fileName, config) {
  const accessKeyId = decrypt(config.s3.accessKeyId);
  const secretAccessKey = decrypt(config.s3.secretAccessKey);
  const region = config.s3.region;
  const bucket = config.s3.bucketName;
  const objectKey = `documents/${Date.now()}-${fileName}`;

  const fileBuffer = await fs.promises.readFile(filePath);
  const payloadHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const shortDate = dateStamp.substring(0, 8);
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const canonicalUri = `/${objectKey}`;

  const headers = {
    host: host,
    "x-amz-date": dateStamp,
    "x-amz-content-sha256": payloadHash,
    "content-type": "application/octet-stream"
  };

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map(k => `${k}:${headers[k]}\n`).join("");

  const canonicalRequest = [
    "PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash
  ].join("\n");

  const credentialScope = `${shortDate}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", dateStamp, credentialScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");

  const signingKey = getSignatureKey(secretAccessKey, shortDate, region, "s3");
  const signature = crypto.createHmac("sha256", signingKey)
    .update(stringToSign).digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(`https://${host}${canonicalUri}`, {
    method: "PUT",
    headers: {
      ...headers,
      Authorization: authorization
    },
    body: fileBuffer
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`S3 upload failed: ${resp.status} ${errBody}`);
  }

  return {
    provider: "s3",
    url: `https://${host}${canonicalUri}`,
    path: objectKey
  };
}

async function testS3(config) {
  const accessKeyId = decrypt(config.s3.accessKeyId);
  const secretAccessKey = decrypt(config.s3.secretAccessKey);
  const region = config.s3.region;
  const bucket = config.s3.bucketName;

  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const shortDate = dateStamp.substring(0, 8);
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");

  const headers = {
    host,
    "x-amz-date": dateStamp,
    "x-amz-content-sha256": payloadHash
  };

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map(k => `${k}:${headers[k]}\n`).join("");

  const canonicalRequest = [
    "GET", "/", "", canonicalHeaders, signedHeaders, payloadHash
  ].join("\n");

  const credentialScope = `${shortDate}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", dateStamp, credentialScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");

  const signingKey = getSignatureKey(secretAccessKey, shortDate, region, "s3");
  const signature = crypto.createHmac("sha256", signingKey)
    .update(stringToSign).digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(`https://${host}/`, {
    method: "GET",
    headers: { ...headers, Authorization: authorization }
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`S3 test failed: ${resp.status} ${errBody}`);
  }

  return { success: true, message: `Connected to bucket "${bucket}"` };
}

// ─── Azure Blob Upload (SharedKey Auth) ─────────────────────────────────────

function createAzureAuthHeader(method, accountName, accountKey, containerName, blobName, contentLength, contentType, dateStr) {
  const canonicalizedHeaders = `x-ms-blob-type:BlockBlob\nx-ms-date:${dateStr}\nx-ms-version:2020-10-02`;
  const canonicalizedResource = `/${accountName}/${containerName}/${blobName}`;

  const stringToSign = [
    method,                  // HTTP verb
    "",                      // Content-Encoding
    "",                      // Content-Language
    contentLength.toString(),// Content-Length
    "",                      // Content-MD5
    contentType,             // Content-Type
    "",                      // Date
    "",                      // If-Modified-Since
    "",                      // If-Match
    "",                      // If-None-Match
    "",                      // If-Unmodified-Since
    "",                      // Range
    canonicalizedHeaders,
    canonicalizedResource
  ].join("\n");

  const key = Buffer.from(accountKey, "base64");
  const hmac = crypto.createHmac("sha256", key).update(stringToSign, "utf8").digest("base64");
  return `SharedKey ${accountName}:${hmac}`;
}

async function uploadToAzure(filePath, fileName, config) {
  const accountName = config.azure.accountName;
  const accountKey = decrypt(config.azure.accountKey);
  const containerName = config.azure.containerName;
  const blobName = `documents/${Date.now()}-${fileName}`;

  const fileBuffer = await fs.promises.readFile(filePath);
  const dateStr = new Date().toUTCString();
  const contentType = "application/octet-stream";

  const authorization = createAzureAuthHeader(
    "PUT", accountName, accountKey, containerName, blobName,
    fileBuffer.length, contentType, dateStr
  );

  const url = `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}`;

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      "Content-Length": fileBuffer.length.toString(),
      "x-ms-blob-type": "BlockBlob",
      "x-ms-date": dateStr,
      "x-ms-version": "2020-10-02"
    },
    body: fileBuffer
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Azure upload failed: ${resp.status} ${errBody}`);
  }

  return {
    provider: "azure",
    url,
    path: blobName
  };
}

async function testAzure(config) {
  const accountName = config.azure.accountName;
  const accountKey = decrypt(config.azure.accountKey);
  const containerName = config.azure.containerName;
  const dateStr = new Date().toUTCString();

  // List blobs (maxresults=1) to test connectivity
  const canonicalizedHeaders = `x-ms-date:${dateStr}\nx-ms-version:2020-10-02`;
  const canonicalizedResource = `/${accountName}/${containerName}\ncomp:list\nmaxresults:1\nrestype:container`;

  const stringToSign = [
    "GET", "", "", "", "", "", "", "", "", "", "", "",
    canonicalizedHeaders,
    canonicalizedResource
  ].join("\n");

  const key = Buffer.from(accountKey, "base64");
  const hmac = crypto.createHmac("sha256", key).update(stringToSign, "utf8").digest("base64");
  const authorization = `SharedKey ${accountName}:${hmac}`;

  const url = `https://${accountName}.blob.core.windows.net/${containerName}?restype=container&comp=list&maxresults=1`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: authorization,
      "x-ms-date": dateStr,
      "x-ms-version": "2020-10-02"
    }
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Azure test failed: ${resp.status} ${errBody}`);
  }

  return { success: true, message: `Connected to container "${containerName}"` };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Upload a file to the active cloud provider, or keep it local.
 * Returns { provider, url, path }.
 */
async function uploadFile(localFilePath, originalName) {
  try {
    const config = await StorageConfig.getConfig();

    if (!config.isActive || config.provider === "local") {
      return {
        provider: "local",
        url: null,
        path: `uploads/${path.basename(localFilePath)}`
      };
    }

    switch (config.provider) {
      case "gcs":
        return await uploadToGCS(localFilePath, originalName, config);
      case "s3":
        return await uploadToS3(localFilePath, originalName, config);
      case "azure":
        return await uploadToAzure(localFilePath, originalName, config);
      default:
        return {
          provider: "local",
          url: null,
          path: `uploads/${path.basename(localFilePath)}`
        };
    }
  } catch (err) {
    // Fallback to local storage on any cloud error
    logger.error("Cloud upload failed, falling back to local storage", {
      error: err.message
    });
    return {
      provider: "local",
      url: null,
      path: `uploads/${path.basename(localFilePath)}`
    };
  }
}

/**
 * Test connectivity to a provider with given credentials.
 */
async function testConnection(provider, credentials) {
  const configObj = { gcs: {}, s3: {}, azure: {} };

  switch (provider) {
    case "gcs":
      configObj.gcs = {
        projectId: credentials.projectId,
        bucketName: credentials.bucketName,
        credentials: encrypt(credentials.credentials)
      };
      return await testGCS(configObj);

    case "s3":
      configObj.s3 = {
        region: credentials.region,
        bucketName: credentials.bucketName,
        accessKeyId: encrypt(credentials.accessKeyId),
        secretAccessKey: encrypt(credentials.secretAccessKey)
      };
      return await testS3(configObj);

    case "azure":
      configObj.azure = {
        accountName: credentials.accountName,
        containerName: credentials.containerName,
        accountKey: encrypt(credentials.accountKey)
      };
      return await testAzure(configObj);

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Migrate existing local documents to the active cloud provider.
 * Runs asynchronously — updates progress in the StorageConfig document.
 */
async function migrateExistingDocuments() {
  const Document = require("../models/document.model");
  const config = await StorageConfig.getConfig();

  if (!config.isActive || config.provider === "local") {
    throw new Error("No cloud provider is active");
  }

  // Find all documents with local file paths (not already on cloud)
  const localDocs = await Document.find({
    filePath: { $regex: /^uploads\// }
  });

  if (localDocs.length === 0) {
    return { total: 0, completed: 0, failed: 0 };
  }

  // Update migration status
  config.migrationStatus = "running";
  config.migrationProgress = { total: localDocs.length, completed: 0, failed: 0 };
  await config.save();

  let completed = 0;
  let failed = 0;

  for (const doc of localDocs) {
    try {
      const localPath = path.join(__dirname, "..", doc.filePath);

      // Check if file exists
      try {
        await fs.promises.access(localPath, fs.constants.R_OK);
      } catch {
        logger.warn("Migration: file not found on disk, skipping", {
          docId: doc._id.toString(),
          filePath: doc.filePath
        });
        failed++;
        continue;
      }

      let result;
      switch (config.provider) {
        case "gcs":
          result = await uploadToGCS(localPath, doc.fileName, config);
          break;
        case "s3":
          result = await uploadToS3(localPath, doc.fileName, config);
          break;
        case "azure":
          result = await uploadToAzure(localPath, doc.fileName, config);
          break;
      }

      // Update document with cloud path
      doc.filePath = result.path;
      doc.cloudUrl = result.url;
      doc.storageProvider = result.provider;
      await doc.save();

      completed++;
    } catch (err) {
      logger.error("Migration failed for document", {
        docId: doc._id.toString(),
        error: err.message
      });
      failed++;
    }

    // Update progress
    config.migrationProgress = { total: localDocs.length, completed, failed };
    await config.save();
  }

  config.migrationStatus = failed === 0 ? "completed" : "failed";
  config.lastMigrationAt = new Date();
  await config.save();

  logger.info("Migration complete", { total: localDocs.length, completed, failed });
  return { total: localDocs.length, completed, failed };
}

module.exports = {
  encrypt,
  decrypt,
  uploadFile,
  testConnection,
  migrateExistingDocuments
};
