import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

loadEnv(path.join(ROOT, ".env"));

export const OPERATIONAL_NAMES = Object.freeze([
  "David",
  "Mark",
  "Tala",
  "Huong",
  "Paulo",
  "Bob",
  "Dung",
  "Lan",
  "Lien",
  "Hoi",
  "Son",
  "Chien",
  "Ito",
  "Hong",
  "Tu",
  "Nghia",
  "Vinh",
  "Kevin",
  "Ninh",
  "Phat",
  "Linh",
  "Dieu",
  "Amy",
  "Thi",
  "Tri",
  "Niel",
  "David 2",
  "Kevin Le",
  "Lucy",
  "Nga",
]);

const VALUE_LIMITS = Object.freeze({
  normal_values: 25,
  costco_values: 10,
  lidoff_values: 3,
});

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
});

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://script.google.com https://script.googleusercontent.com",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;

  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
    if (isDoubleQuoted || isSingleQuoted) value = value.slice(1, -1);

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return String(value).trim().toLowerCase() === "true";
}

function requestTimeoutMs() {
  const value = Number(process.env.REQUEST_TIMEOUT_MS || 90_000);
  return Number.isFinite(value) && value > 0 ? value : 90_000;
}

function httpError(message, status = 500, expose = status < 500) {
  return Object.assign(new Error(message), { status, expose });
}

function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function addCors(headers, origin) {
  if (!origin || !allowedOrigins().includes(origin)) return;

  headers["Access-Control-Allow-Origin"] = origin;
  headers.Vary = "Origin";
  headers["Access-Control-Allow-Headers"] = "Content-Type";
  headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
}

function sendJson(response, status, payload, origin = "") {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };

  addCors(headers, origin);
  response.writeHead(status, headers);
  response.end(body);
}

async function readJsonBody(request, maxBytes = 15 * 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw httpError("Request body is too large.", 413);
    chunks.push(chunk);
  }

  try {
    const text = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(text || "{}");
  } catch {
    throw httpError("Request body must be valid JSON.", 400);
  }
}

export function validateImageDataUrl(value) {
  if (typeof value !== "string") {
    throw httpError("imageDataUrl is required.", 400);
  }

  const match = value.match(
    /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/,
  );
  if (!match) throw httpError("Use a JPG, PNG, or WebP image.", 400);

  const compactBase64 = match[2].replace(/\s/g, "");
  const estimatedBytes = Math.floor((compactBase64.length * 3) / 4);
  if (estimatedBytes > 10 * 1024 * 1024) {
    throw httpError("The prepared image exceeds 10 MB.", 413);
  }

  return `data:${match[1]};base64,${compactBase64}`;
}

export function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;

    for (const content of item.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
      if (content?.type === "refusal") {
        throw httpError(
          content.refusal || "The model declined the extraction request.",
          422,
        );
      }
    }
  }

  throw httpError("The model returned no structured text.", 502);
}

function cleanOcrValues(values, field, warnings, rowLabel) {
  const limit = VALUE_LIMITS[field];
  const clean = [];

  for (const rawValue of Array.isArray(values) ? values : []) {
    const value = Number(rawValue);
    if (Number.isFinite(value) && value > 0 && value <= 999) {
      clean.push(value);
    } else {
      warnings.push(
        `${rowLabel}: ignored an invalid ${field.replace("_values", "")} value.`,
      );
    }
  }

  if (clean.length > limit) {
    warnings.push(
      `${rowLabel}: kept the first ${limit} ${field.replace("_values", "")} values.`,
    );
    return clean.slice(0, limit);
  }

  return clean;
}

export function normaliseOcrResult(value) {
  const warnings = Array.isArray(value?.warnings)
    ? value.warnings.map(String).slice(0, 50)
    : [];
  const rows = [];

  const rawRows = Array.isArray(value?.rows) ? value.rows : [];
  rawRows.forEach((rawRow, index) => {
    const rowLabel = `Row ${rawRow?.row_number ?? index + 1}`;
    const name = OPERATIONAL_NAMES.includes(rawRow?.name) ? rawRow.name : "";

    if (!name) warnings.push(`${rowLabel}: worker name requires review.`);

    rows.push({
      row_number: Number.isInteger(rawRow?.row_number) ? rawRow.row_number : null,
      name,
      normal_values: cleanOcrValues(
        rawRow?.normal_values,
        "normal_values",
        warnings,
        rowLabel,
      ),
      costco_values: cleanOcrValues(
        rawRow?.costco_values,
        "costco_values",
        warnings,
        rowLabel,
      ),
      lidoff_values: cleanOcrValues(
        rawRow?.lidoff_values,
        "lidoff_values",
        warnings,
        rowLabel,
      ),
      confidence: Math.max(0, Math.min(1, Number(rawRow?.confidence) || 0)),
      notes: String(rawRow?.notes || "").slice(0, 500),
    });
  });

  rows.sort((left, right) => {
    return (left.row_number ?? 9_999) - (right.row_number ?? 9_999);
  });

  return { rows, warnings: [...new Set(warnings)] };
}

function ocrSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            row_number: { type: ["integer", "null"] },
            name: { type: "string", enum: ["", ...OPERATIONAL_NAMES] },
            normal_values: { type: "array", items: { type: "number" } },
            costco_values: { type: "array", items: { type: "number" } },
            lidoff_values: { type: "array", items: { type: "number" } },
            confidence: { type: "number" },
            notes: { type: "string" },
          },
          required: [
            "row_number",
            "name",
            "normal_values",
            "costco_values",
            "lidoff_values",
            "confidence",
            "notes",
          ],
        },
      },
      warnings: { type: "array", items: { type: "string" } },
    },
    required: ["rows", "warnings"],
  };
}

async function callOpenAi(imageDataUrl) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw httpError("OPENAI_API_KEY is not configured.", 503);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs());

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-5-mini",
        store: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "Extract the handwritten oyster tray table into structured rows.",
                  "Use the printed row number when visible.",
                  `Select a worker name only from this list: ${OPERATIONAL_NAMES.join(", ")}. Use an empty name when uncertain.`,
                  "Read all uncrossed numeric entries on the same row.",
                  "Use normal_values unless the sheet explicitly identifies Costco or LidOff values.",
                  "Do not invent unclear digits. Explain uncertainty in notes and lower confidence.",
                  "Return one output row per visible worker row.",
                ].join(" "),
              },
              {
                type: "input_image",
                image_url: imageDataUrl,
                detail: process.env.OPENAI_IMAGE_DETAIL || "high",
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "tray_tally_rows",
            strict: true,
            schema: ocrSchema(),
          },
        },
        max_output_tokens: 5_000,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        payload?.error?.message || `OpenAI request failed (${response.status}).`;
      throw httpError(message, response.status === 429 ? 429 : 502, true);
    }

    return JSON.parse(extractOutputText(payload));
  } catch (error) {
    if (error?.name === "AbortError") {
      throw httpError("Image extraction timed out.", 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function cleanApiValues(values, maximum, rowIndex) {
  if (!Array.isArray(values) || values.length > maximum) {
    throw httpError(
      `Row ${rowIndex + 1} contains an invalid number of values.`,
      400,
    );
  }

  const clean = values.map(Number);
  const hasInvalid = clean.some((value) => {
    return !Number.isFinite(value) || value <= 0 || value > 999;
  });
  if (hasInvalid) {
    throw httpError(`Row ${rowIndex + 1} contains an invalid tray value.`, 400);
  }

  return clean;
}

function validateRecordRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw httpError("At least one confirmed row is required.", 400);
  }
  if (rows.length > 100) {
    throw httpError("A maximum of 100 rows can be saved at once.", 400);
  }

  return rows.map((row, index) => {
    if (!OPERATIONAL_NAMES.includes(row?.name)) {
      throw httpError(`Row ${index + 1} has an unknown worker name.`, 400);
    }

    const normalValues = cleanApiValues(row.normal_values, 25, index);
    const costcoValues = cleanApiValues(row.costco_values, 10, index);
    const lidOffValues = cleanApiValues(row.lidoff_values, 3, index);

    if (!normalValues.length && !costcoValues.length && !lidOffValues.length) {
      throw httpError(`Row ${index + 1} has no tray values.`, 400);
    }

    return {
      row_number: Number.isInteger(row.row_number) ? row.row_number : null,
      name: row.name,
      normal_values: normalValues,
      costco_values: costcoValues,
      lidoff_values: lidOffValues,
    };
  });
}

async function forwardToAppsScript(payload) {
  const target = process.env.GOOGLE_APPS_SCRIPT_URL;
  if (!target) {
    throw httpError("GOOGLE_APPS_SCRIPT_URL is not configured.", 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs());

  try {
    const response = await fetch(target, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw httpError("Google Apps Script returned a non-JSON response.", 502);
    }

    if (!response.ok || data.error) {
      throw httpError(
        data.error || `Google Apps Script failed (${response.status}).`,
        502,
      );
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw httpError("Spreadsheet request timed out.", 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function demoMode() {
  return parseBoolean(process.env.DEMO_MODE, true);
}

async function handleApi(request, response, url, origin) {
  if (request.method === "OPTIONS") {
    const headers = {};
    addCors(headers, origin);
    response.writeHead(204, headers);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(
      response,
      200,
      {
        ok: true,
        demoMode: demoMode(),
        ocrMockMode: parseBoolean(process.env.OCR_MOCK_MODE),
      },
      origin,
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(
      response,
      200,
      { workerNames: OPERATIONAL_NAMES, demoMode: demoMode() },
      origin,
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ocr") {
    const body = await readJsonBody(request);
    const imageDataUrl = validateImageDataUrl(body.imageDataUrl);
    const result = normaliseOcrResult(await callOpenAi(imageDataUrl));
    sendJson(response, 200, result, origin);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/records") {
    const body = await readJsonBody(request, 2 * 1024 * 1024);
    const rows = validateRecordRows(body.rows);
    const batchId = String(body.batchId || "").slice(0, 100) || randomUUID();

    if (demoMode()) {
      sendJson(
        response,
        200,
        { ok: true, demoMode: true, batchId, rowsValidated: rows.length },
        origin,
      );
      return;
    }

    const result = await forwardToAppsScript({
      action: "batchAddMany",
      batchId,
      rows,
    });
    sendJson(response, 200, { ...result, demoMode: false }, origin);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/corrections") {
    const body = await readJsonBody(request, 512 * 1024);
    const correctionId =
      String(body.correctionId || "").slice(0, 100) || randomUUID();
    const row = {
      ...body.row,
      name: OPERATIONAL_NAMES.includes(body?.row?.name) ? body.row.name : "",
      notes: String(body?.row?.notes || "").slice(0, 500),
    };

    if (demoMode()) {
      sendJson(
        response,
        200,
        { ok: true, demoMode: true, correctionId },
        origin,
      );
      return;
    }

    const result = await forwardToAppsScript({
      action: "queueCorrection",
      correctionId,
      row,
    });
    sendJson(response, 200, { ...result, demoMode: false }, origin);
    return;
  }

  sendJson(response, 404, { error: "API endpoint not found." }, origin);
}

async function serveStatic(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    sendJson(response, 400, { error: "Invalid URL." });
    return;
  }

  const filePath = path.resolve(PUBLIC_DIR, `.${decodedPath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }

  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error("Not a file");

    const body = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const headers = {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    };

    response.writeHead(200, headers);
    if (request.method === "HEAD") response.end();
    else response.end(body);
  } catch {
    sendJson(response, 404, { error: "File not found." });
  }
}

export function createServer() {
  return http.createServer(async (request, response) => {
    const origin = String(request.headers.origin || "");
    const url = new URL(request.url || "/", "http://localhost");

    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url, origin);
      } else {
        await serveStatic(request, response, url);
      }
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error(error);
      else if (process.env.NODE_ENV === "development") console.warn(error.message);

      const expectedError = Boolean(error?.status) || Boolean(error?.expose);
      sendJson(
        response,
        status,
        {
          error: expectedError
            ? error.message
            : "The server could not complete the request.",
          detail:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        },
        origin,
      );
    }
  });
}

const isDirectExecution =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const port = Number(process.env.PORT || 3_000);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`Tray Tally running at http://localhost:${port}`);
  });
}
