/**
 * KTAF AI Big Board — Google Sheets → GitHub Sync Script
 *
 * SETUP (one-time):
 *   1. In the Google Sheet, go to Extensions > Apps Script
 *   2. Paste this entire file and save
 *   3. Reload the spreadsheet — you'll see a "🚀 Big Board" menu appear
 *   4. Go to Big Board > Set GitHub Token
 *      Paste a GitHub Personal Access Token (PAT) with repo Contents read/write scope
 *      (Settings > Developer settings > Personal access tokens > Fine-grained)
 *   5. Update the CONFIG block below with your GitHub repo info
 *   6. Use Big Board > Sync to GitHub to push data.json
 *
 * WHO CAN SYNC:
 *   Anyone with Editor access to this spreadsheet can run the sync via the menu.
 *   Each person needs to set their own token once via Big Board > Set GitHub Token.
 */

// ─── CONFIG — update these before first sync ─────────────────────────────────
const GH_OWNER  = 'YOUR_GITHUB_USERNAME_OR_ORG';  // e.g. 'teamschools'
const GH_REPO   = 'big-board';                      // your GitHub repo name
const GH_BRANCH = 'main';
const GH_FILE   = 'data.json';
const SHEET_GID = '1836632150';                     // from the GSheet URL (gid=...)
// ─────────────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🚀 Big Board')
    .addItem('Sync to GitHub', 'syncToGitHub')
    .addItem('Preview JSON (view logs)', 'previewJSON')
    .addSeparator()
    .addItem('Set GitHub Token', 'promptForToken')
    .addToUi();
}

// ─── Menu Actions ─────────────────────────────────────────────────────────────

function syncToGitHub() {
  const ui = SpreadsheetApp.getUi();
  try {
    const payload = buildJSON();
    const jsonStr = JSON.stringify(payload, null, 2);
    commitToGitHub(jsonStr);
    ui.alert(
      '✅ Synced',
      `${payload.items.length} items pushed to ${GH_OWNER}/${GH_REPO}.\n\nThe board will update within ~30 seconds via GitHub Pages.`,
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('❌ Sync failed', e.message, ui.ButtonSet.OK);
  }
}

function previewJSON() {
  const payload = buildJSON();
  Logger.log('─── PREVIEW ───');
  Logger.log(JSON.stringify(payload, null, 2));
  Logger.log(`Total items: ${payload.items.length}`);
  SpreadsheetApp.getUi().alert('Preview written to View > Logs', ui.ButtonSet.OK);
}

function promptForToken() {
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt(
    'GitHub Personal Access Token',
    'Paste your PAT (fine-grained, Contents: read + write on your repo).\nThis is stored securely in your user properties — not visible to others.',
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() === ui.Button.OK) {
    const token = result.getResponseText().trim();
    if (!token) { ui.alert('No token entered.'); return; }
    PropertiesService.getUserProperties().setProperty('GH_TOKEN', token);
    ui.alert('Token saved ✓', 'You can now sync to GitHub.', ui.ButtonSet.OK);
  }
}

// ─── Build JSON Payload ───────────────────────────────────────────────────────

function buildJSON() {
  // Find the target sheet by GID
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets().find(s => String(s.getSheetId()) === SHEET_GID)
    || ss.getActiveSheet();

  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0];
  const col     = {};
  headers.forEach((h, i) => { col[String(h).trim()] = i; });

  const TEMPLATE_MARKER = '👉';
  const items = [];

  for (let r = 1; r < rows.length; r++) {
    const row  = rows[r];
    const name = String(row[col['Name']] || '').trim();

    // Skip blank rows and the Asana task template row
    if (!name || name.startsWith(TEMPLATE_MARKER)) continue;

    const stage    = String(row[col['Section/Column']]  || '').trim();
    const creator  = String(row[col['Who Created?']]    || '').trim();
    const rawNotes = String(row[col['Notes']]           || '').trim();
    const rawLink  = String(row[col['Share Link']]      || '').trim();
    const taskId   = String(row[col['Task ID']]         || '').trim();

    // Only treat as a real link if it's an actual HTTP URL
    const shareLink = rawLink.startsWith('http') ? rawLink : null;

    items.push({
      id:         taskId,
      name:       name,
      stage:      stage,
      creator:    creator || null,
      shareLink:  shareLink,
      screenshot: null,
      notes:      parseNotes(rawNotes),
    });
  }

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return { lastUpdated: today, items };
}

// ─── Notes Parser ─────────────────────────────────────────────────────────────
/**
 * The Asana notes field uses a semi-structured format with these section headers:
 *   Purpose
 *   For Who & When
 *   Anticipated Next Steps/Features
 *   Production Audit? What would be needed to go to production?
 *
 * Template placeholders ("...") are stripped. Bracket-style checkboxes like
 * [Already in Prod!] and [Need Auth + Permissions] are treated as audit items.
 */

function parseNotes(raw) {
  const empty = { purpose: null, audience: null, timeline: null, nextSteps: [], productionAudit: [] };
  if (!raw || raw.trim() === '') return empty;

  const lines = raw.split('\n').map(l => l.trim());

  // Section boundaries (case-insensitive match on trimmed line)
  const SEC = {
    purpose:    /^purpose$/i,
    forWho:     /^for who & when$/i,
    nextSteps:  /^anticipated next steps\/features$/i,
    audit:      /^production audit\?/i,
  };

  let currentSection = null;
  const buckets = { purpose: [], forWho: [], nextSteps: [], audit: [] };

  for (const line of lines) {
    if (SEC.purpose.test(line))   { currentSection = 'purpose';   continue; }
    if (SEC.forWho.test(line))    { currentSection = 'forWho';    continue; }
    if (SEC.nextSteps.test(line)) { currentSection = 'nextSteps'; continue; }
    if (SEC.audit.test(line))     { currentSection = 'audit';     continue; }

    if (currentSection && line && !isTemplate(line)) {
      buckets[currentSection].push(line);
    }
  }

  // Purpose: join all lines into one paragraph
  const purpose = buckets.purpose.join(' ').replace(/\s+/g, ' ').trim() || null;

  // For Who & When: first real line = audience, second = timeline
  const whoLines = buckets.forWho.filter(l => !isTemplate(l));
  const audience = whoLines[0] || null;
  const timeline = whoLines[1] || null;

  // Next steps: clean up leading arrows/bullets
  const nextSteps = buckets.nextSteps
    .map(l => l.replace(/^[→\-\*•·]\s*/, '').trim())
    .filter(l => l.length > 2 && !isTemplate(l));

  // Production audit: handle both bracket-style and freeform lines
  const productionAudit = buckets.audit
    .map(l => l.replace(/^\[|\]$/g, '').trim())
    .filter(l => l.length > 2 && !isTemplate(l) && !l.startsWith('Need…') && l !== 'Need...');

  return {
    purpose:         isTemplate(purpose) ? null : purpose,
    audience:        isTemplate(audience) ? null : audience,
    timeline:        isTemplate(timeline) ? null : timeline,
    nextSteps,
    productionAudit,
  };
}

function isTemplate(text) {
  if (!text) return true;
  const t = text.trim();
  return t === '' || t === '...' || t === '…';
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

function commitToGitHub(content) {
  const token = PropertiesService.getUserProperties().getProperty('GH_TOKEN');
  if (!token) throw new Error('No GitHub token found. Use Big Board > Set GitHub Token first.');

  const apiUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;
  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // Fetch current file SHA (required for updates — 404 is fine for first push)
  let sha = null;
  try {
    const get = UrlFetchApp.fetch(apiUrl, { method: 'GET', headers, muteHttpExceptions: true });
    if (get.getResponseCode() === 200) {
      sha = JSON.parse(get.getContentText()).sha;
    }
  } catch (_) { /* first push — no SHA needed */ }

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const body  = { message: `sync: big board data ${today}`, branch: GH_BRANCH,
                  content: Utilities.base64Encode(content, Utilities.Charset.UTF_8) };
  if (sha) body.sha = sha;

  const put = UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const code = put.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error(`GitHub API returned ${code}: ${put.getContentText().slice(0, 300)}`);
  }
}
