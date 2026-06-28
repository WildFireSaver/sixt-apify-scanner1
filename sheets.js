import { google } from 'googleapis';

export const SHEET_HEADER = [
  'scanned_at',
  'pickup_location',
  'return_location',
  'pickup_datetime',
  'return_datetime',
  'rental_days',
  'requested_categories',
  'vehicle_category',
  'category_matched',
  'example_vehicle',
  'rate_type',
  'total_price',
  'daily_price',
  'currency',
  'booking_url',
  'source',
];

function getSheetsClient(serviceAccount) {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some((s) => s.properties?.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }
}

async function ensureHeader(sheets, spreadsheetId, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!1:1`,
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADER] },
    });
  }
}

/**
 * Append rows (array of objects keyed by SHEET_HEADER) to a Google Sheet tab.
 */
export async function appendToSheet({ serviceAccount, spreadsheetId, tabName, rows }) {
  if (!rows.length) return { appended: 0 };
  const sheets = getSheetsClient(serviceAccount);

  await ensureTab(sheets, spreadsheetId, tabName);
  await ensureHeader(sheets, spreadsheetId, tabName);

  const values = rows.map((r) => SHEET_HEADER.map((h) => (r[h] ?? '')));

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return { appended: values.length };
}
