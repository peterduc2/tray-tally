const SPREADSHEET_ID = "REPLACE_WITH_SPREADSHEET_ID";
const ENTRIES_SHEET = "TrayEntries";
const SUMMARY_SHEET = "TraySummary";
const CORRECTION_QUEUE_SHEET = "CorrectionQueue";
const CORRECTION_DOCUMENT_ID = "REPLACE_WITH_GOOGLE_DOC_ID";
const OPERATIONAL_NAMES = ["David", "Mark", "Tala", "Huong", "Paulo", "Bob", "Dung", "Lan", "Lien", "Hoi", "Son", "Chien", "Ito", "Hong", "Tu", "Nghia", "Vinh", "Kevin", "Ninh", "Phat", "Linh", "Dieu", "Amy", "Thi", "Tri", "Niel", "David 2", "Kevin Le", "Lucy", "Nga"];
const ALLOWED_TYPES = ["normal", "costco", "lidoff"];
const VALUE_LIMITS = { normal: 25, costco: 10, lidoff: 3 };

function doGet(e) {
  return handleRequest_(e && e.parameter ? e.parameter : {});
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    return handleRequest_(body);
  } catch (error) {
    return json_({ error: errorMessage_(error) });
  }
}

function handleRequest_(request) {
  try {
    const action = String(request.action || "");
    if (action === "add") return addSingle_(request);
    if (action === "undo") return undo_(request);
    if (action === "batchAddMany") return batchAddMany_(request);
    if (action === "queueCorrection") return queueCorrection_(request);
    if (action === "queueVoiceCorrection") {
      return queueCorrection_({
        correctionId: request.correctionId || Utilities.getUuid(),
        row: {
          row_number: "",
          name: request.name || "",
          normal_values: request.type === "normal" && request.value ? [Number(request.value)] : [],
          costco_values: request.type === "costco" && request.value ? [Number(request.value)] : [],
          lidoff_values: request.type === "lidoff" && request.value ? [Number(request.value)] : [],
          notes: "Rejected voice input: " + clean_(request.raw, 300)
        }
      });
    }

    // Backward-compatible action names from the earlier prototype.
    if (action === "batchAdd") {
      return batchAddMany_({
        batchId: request.batchId || Utilities.getUuid(),
        workDate: request.workDate,
        rows: [request]
      });
    }
    if (action === "correction") {
      return queueCorrection_({
        correctionId: request.correctionId || Utilities.getUuid(),
        row: request
      });
    }
    return json_({ error: "Unknown action" });
  } catch (error) {
    return json_({ error: errorMessage_(error) });
  }
}

function spreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function entriesSheet_() {
  const spreadsheet = spreadsheet_();
  let sheet = spreadsheet.getSheetByName(ENTRIES_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(ENTRIES_SHEET);
    sheet.appendRow([
      "Entry ID", "Timestamp", "Work Date", "Name", "Type",
      "Value", "Source", "Batch ID", "Active", "Undone At"
    ]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function summarySheet_() {
  const spreadsheet = spreadsheet_();
  let sheet = spreadsheet.getSheetByName(SUMMARY_SHEET);
  if (!sheet) sheet = spreadsheet.insertSheet(SUMMARY_SHEET);
  return sheet;
}

function correctionQueueSheet_() {
  const spreadsheet = spreadsheet_();
  let sheet = spreadsheet.getSheetByName(CORRECTION_QUEUE_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(CORRECTION_QUEUE_SHEET);
    sheet.appendRow(["Correction ID", "Queued At", "Due At", "Payload", "Processed At"]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function addSingle_(request) {
  const entry = validateEntry_({
    id: request.id || Utilities.getUuid(),
    workDate: request.workDate,
    name: request.name,
    type: request.type,
    value: request.value,
    source: "voice",
    batchId: ""
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (entryExists_(entry.id)) {
      return json_({ ok: true, duplicate: true, id: entry.id });
    }
    entriesSheet_().appendRow([
      entry.id, new Date(), entry.workDate, entry.name, entry.type,
      entry.value, entry.source, entry.batchId, true, ""
    ]);
    updateSummaryForNames_([entry.name], entry.workDate);
    return json_({ ok: true, id: entry.id });
  } finally {
    lock.releaseLock();
  }
}

function batchAddMany_(request) {
  const batchId = clean_(request.batchId || Utilities.getUuid(), 100);
  const workDate = normaliseWorkDate_(request.workDate);
  const inputRows = Array.isArray(request.rows) ? request.rows : [];
  if (!inputRows.length || inputRows.length > 100) throw new Error("Invalid batch size");

  const entries = [];
  inputRows.forEach(function(row, rowIndex) {
    const name = validateName_(row.name);
    [
      ["normal", validateValueArray_(row.normal_values, "normal")],
      ["costco", validateValueArray_(row.costco_values, "costco")],
      ["lidoff", validateValueArray_(row.lidoff_values, "lidoff")]
    ].forEach(function(pair) {
      const type = pair[0];
      pair[1].forEach(function(value, valueIndex) {
        entries.push(validateEntry_({
          id: batchId + "-" + rowIndex + "-" + type + "-" + valueIndex,
          workDate: workDate,
          name: name,
          type: type,
          value: value,
          source: "photo-reviewed",
          batchId: batchId
        }));
      });
    });
  });
  if (!entries.length) throw new Error("No valid values");

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const existingIds = existingIds_();
    const timestamp = new Date();
    const newRows = entries
      .filter(function(entry) { return !existingIds[entry.id]; })
      .map(function(entry) {
        return [
          entry.id, timestamp, entry.workDate, entry.name, entry.type,
          entry.value, entry.source, entry.batchId, true, ""
        ];
      });

    if (newRows.length) {
      const sheet = entriesSheet_();
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
    }
    updateSummaryForNames_(unique_(entries.map(function(entry) { return entry.name; })), workDate);
    return json_({
      ok: true,
      batchId: batchId,
      rowsAdded: newRows.length,
      duplicates: entries.length - newRows.length
    });
  } finally {
    lock.releaseLock();
  }
}

function undo_(request) {
  const id = clean_(request.id || "", 100);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = entriesSheet_();
    const values = sheet.getDataRange().getValues();
    for (let index = values.length - 1; index >= 1; index--) {
      const idMatch = id && String(values[index][0]) === id;
      const fallbackMatch = !id &&
        String(values[index][3]) === clean_(request.name, 100) &&
        String(values[index][4]) === clean_(request.type, 20) &&
        Number(values[index][5]) === Number(request.value);
      if ((idMatch || fallbackMatch) && values[index][8] === true) {
        sheet.getRange(index + 1, 9, 1, 2).setValues([[false, new Date()]]);
        updateSummaryForNames_([String(values[index][3])], String(values[index][2]));
        return json_({ ok: true, id: values[index][0] });
      }
    }
    return json_({ error: "Matching active entry not found" });
  } finally {
    lock.releaseLock();
  }
}

function validateEntry_(entry) {
  const type = clean_(entry.type, 20);
  const value = Number(entry.value);
  if (ALLOWED_TYPES.indexOf(type) < 0) throw new Error("Invalid entry type");
  if (!isFinite(value) || value <= 0 || value > 999) throw new Error("Invalid tray value");
  return {
    id: clean_(entry.id || Utilities.getUuid(), 100),
    workDate: normaliseWorkDate_(entry.workDate),
    name: validateName_(entry.name),
    type: type,
    value: value,
    source: clean_(entry.source, 50),
    batchId: clean_(entry.batchId, 100)
  };
}

function validateValueArray_(values, type) {
  const input = Array.isArray(values) ? values : [];
  if (input.length > VALUE_LIMITS[type]) throw new Error("Too many " + type + " values");
  return input.map(function(rawValue) {
    const value = Number(rawValue);
    if (!isFinite(value) || value <= 0 || value > 999) throw new Error("Invalid " + type + " value");
    return value;
  });
}

function validateName_(name) {
  const cleaned = clean_(name, 100);
  if (OPERATIONAL_NAMES.indexOf(cleaned) < 0) throw new Error("Unknown worker name: " + cleaned);
  return cleaned;
}

function normaliseWorkDate_(value) {
  const candidate = clean_(value || today_(), 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) throw new Error("Invalid work date");
  return candidate;
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function existingIds_() {
  const values = entriesSheet_().getDataRange().getValues();
  const ids = {};
  for (let index = 1; index < values.length; index++) ids[String(values[index][0])] = true;
  return ids;
}

function entryExists_(id) {
  return !!existingIds_()[id];
}

function ensureSummaryLayout_(workDate) {
  const targetDate = normaliseWorkDate_(workDate);
  const sheet = summarySheet_();
  const needsReset = sheet.getLastRow() < OPERATIONAL_NAMES.length + 1 ||
    String(sheet.getRange(2, 1).getValue() || "") !== targetDate;
  if (!needsReset) return sheet;

  sheet.clearContents();
  sheet.getRange(1, 1, 1, 12).setValues([[
    "Work Date", "Name", "Normal Values", "Normal Sum",
    "Costco Values", "Costco Raw", "Costco Converted",
    "LidOff Values", "LidOff Raw", "LidOff Converted",
    "Total", "Updated"
  ]]);
  const rows = OPERATIONAL_NAMES.map(function(name) {
    return [targetDate, name, "", 0, "", 0, "", "", 0, "", "", new Date()];
  });
  sheet.getRange(2, 1, rows.length, 12).setValues(rows);
  for (let row = 2; row < 2 + rows.length; row++) {
    sheet.getRange(row, 7).setFormula("=ROUND(F" + row + "*14/12,0)");
    sheet.getRange(row, 10).setFormula("=ROUND(I" + row + "*13/17,0)");
    sheet.getRange(row, 11).setFormula("=D" + row + "+G" + row + "+J" + row);
  }
  sheet.setFrozenRows(1);
  return sheet;
}

function updateSummaryForNames_(names, workDate) {
  const targetDate = normaliseWorkDate_(workDate);
  const validNames = unique_(names).filter(function(name) {
    return OPERATIONAL_NAMES.indexOf(name) >= 0;
  });
  if (!validNames.length) return;

  const sheet = ensureSummaryLayout_(targetDate);
  const grouped = {};
  validNames.forEach(function(name) {
    grouped[name] = { normal: [], costco: [], lidoff: [] };
  });

  const values = entriesSheet_().getDataRange().getValues();
  for (let index = 1; index < values.length; index++) {
    if (String(values[index][2]) !== targetDate || values[index][8] !== true) continue;
    const name = String(values[index][3]);
    const type = String(values[index][4]);
    const value = Number(values[index][5]);
    if (grouped[name] && ALLOWED_TYPES.indexOf(type) >= 0 && isFinite(value)) {
      grouped[name][type].push(value);
    }
  }

  validNames.forEach(function(name) {
    const row = OPERATIONAL_NAMES.indexOf(name) + 2;
    const data = grouped[name];
    sheet.getRange(row, 1, 1, 6).setValues([[
      targetDate, name, data.normal.join(", "), sum_(data.normal),
      data.costco.join(", "), sum_(data.costco)
    ]]);
    sheet.getRange(row, 8, 1, 2).setValues([[
      data.lidoff.join(", "), sum_(data.lidoff)
    ]]);
    sheet.getRange(row, 7).setFormula("=ROUND(F" + row + "*14/12,0)");
    sheet.getRange(row, 10).setFormula("=ROUND(I" + row + "*13/17,0)");
    sheet.getRange(row, 11).setFormula("=D" + row + "+G" + row + "+J" + row);
    sheet.getRange(row, 12).setValue(new Date());
  });
}

function unique_(values) {
  return values.filter(function(value, index, array) {
    return array.indexOf(value) === index;
  });
}

function queueCorrection_(request) {
  const correctionId = clean_(request.correctionId || Utilities.getUuid(), 100);
  const row = request.row || {};
  const dueAt = new Date(Date.now() + 60000);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = correctionQueueSheet_();
    const values = sheet.getDataRange().getValues();
    for (let index = 1; index < values.length; index++) {
      if (String(values[index][0]) === correctionId) {
        return json_({ ok: true, duplicate: true, correctionId: correctionId });
      }
    }
    sheet.appendRow([correctionId, new Date(), dueAt, JSON.stringify(row), ""]);
    ensureCorrectionTrigger_();
    return json_({ ok: true, correctionId: correctionId, dueAt: dueAt.toISOString() });
  } finally {
    lock.releaseLock();
  }
}

function ensureCorrectionTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === "processCorrectionQueue_";
  });
  if (!exists) {
    ScriptApp.newTrigger("processCorrectionQueue_").timeBased().after(60000).create();
  }
}

function processCorrectionQueue_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let pending = false;
  try {
    const sheet = correctionQueueSheet_();
    const values = sheet.getDataRange().getValues();
    const now = Date.now();
    const document = DocumentApp.openById(CORRECTION_DOCUMENT_ID);
    const body = document.getBody();

    for (let index = 1; index < values.length; index++) {
      if (values[index][4]) continue;
      const dueAt = new Date(values[index][2]).getTime();
      if (dueAt > now) {
        pending = true;
        continue;
      }
      let row = {};
      try { row = JSON.parse(String(values[index][3] || "{}")); } catch (error) {}
      body.appendParagraph(
        new Date().toISOString() +
        " | Review row " + (row.row_number || "") +
        " | " + clean_(row.name, 100) +
        " | Normal: " + JSON.stringify(row.normal_values || []) +
        " | Costco: " + JSON.stringify(row.costco_values || []) +
        " | LidOff: " + JSON.stringify(row.lidoff_values || []) +
        " | Notes: " + clean_(row.notes, 500)
      );
      sheet.getRange(index + 1, 5).setValue(new Date());
    }
    document.saveAndClose();
  } catch (error) {
    pending = true;
    throw error;
  } finally {
    deleteCorrectionTriggers_();
    if (pending) ensureCorrectionTrigger_();
    lock.releaseLock();
  }
}

function deleteCorrectionTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "processCorrectionQueue_") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function sum_(values) {
  return values.reduce(function(total, value) { return total + Number(value || 0); }, 0);
}

function clean_(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength || 200);
}

function errorMessage_(error) {
  return String(error && error.message ? error.message : error);
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
