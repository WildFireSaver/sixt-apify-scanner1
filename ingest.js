const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeDealForIngest(row) {
  const { raw_text, scanned_at, source, ...rest } = row;
  return {
    ...rest,
    raw: { raw_text, scanned_at, source },
  };
}

async function postChunk(ingestUrl, scannerSecret, chunk, scanId) {
  const res = await fetch(ingestUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Primary auth header requested for the v0 endpoint:
      'x-scanner-secret': scannerSecret ?? '',
      // Also provided for flexibility; ignore if unused:
      authorization: scannerSecret ? `Bearer ${scannerSecret}` : undefined,
    },
    body: JSON.stringify({
      scan_id: scanId ?? null,
      deals: chunk.map(normalizeDealForIngest),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ingest responded ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
  }
  return res;
}

/**
 * POST rows to the v0 ingest endpoint in batches, with simple retry/backoff.
 * Auth is sent via the `x-scanner-secret` header (and mirrored in the body).
 */
export async function postResults({ ingestUrl, scannerSecret, rows, scanId = null, batchSize = 200, log }) {
  if (!ingestUrl || !rows.length) return { sent: 0 };
  let sent = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    let attempt = 0;
    let ok = false;
    let lastErr;

    while (attempt < 3 && !ok) {
      try {
        await postChunk(ingestUrl, scannerSecret, chunk, scanId);
        ok = true;
        sent += chunk.length;
      } catch (e) {
        lastErr = e;
        attempt += 1;
        const backoff = 1000 * attempt * attempt;
        log?.warning?.(`Ingest POST failed (attempt ${attempt}): ${e.message}. Retrying in ${backoff}ms.`);
        await sleep(backoff);
      }
    }
    if (!ok) throw lastErr;
  }

  return { sent };
}
