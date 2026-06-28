import { spawn } from 'node:child_process';
import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { SESSION_KEY } from './lib/session.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startProc(cmd, args, name) {
  const p = spawn(cmd, args, { stdio: 'inherit', env: process.env });
  p.on('exit', (code) => log.info(`${name} exited (code ${code})`));
  p.on('error', (e) => log.warning(`${name} could not start: ${e.message}`));
  return p;
}

function runOnce(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit', env: process.env });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}

/**
 * mode: "save-session"
 *
 * Runs a real (headful) Chromium on a virtual X display inside the Apify
 * container, exposed interactively through noVNC on the container's web port.
 * You open the run's Live View, log into SIXT by hand (incl. 2FA/CAPTCHA), and
 * after the time window the Playwright storage state is saved to the
 * Key-Value Store under SIXT_SESSION.
 *
 * Your password is never read or stored by the actor.
 */
export async function saveSession(input) {
  const minutes = input.liveViewMinutes;
  const width = input.liveViewWidth;
  const height = input.liveViewHeight;
  const display = ':99';
  const vncPort = 5900;
  const webPort = Number(
    process.env.ACTOR_WEB_SERVER_PORT || process.env.APIFY_CONTAINER_PORT || 4321
  );
  const liveUrlBase = (
    process.env.ACTOR_WEB_SERVER_URL || process.env.APIFY_CONTAINER_URL || ''
  ).replace(/\/$/, '');

  // 1. Virtual display.
  startProc('Xvfb', [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], 'Xvfb');
  process.env.DISPLAY = display;
  await sleep(2000);

  // 2. Minimal window manager so keyboard/mouse focus works reliably.
  startProc('openbox', [], 'openbox');
  await sleep(1000);

  // 3. Headful Chromium on the display.
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${width},${height}`,
      '--window-position=0,0',
      '--disable-dev-shm-usage',
    ],
  });
  const context = await browser.newContext({ viewport: null, locale: 'en-US' });
  const page = await context.newPage();
  await page
    .goto(input.sixtBaseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch((e) => log.warning(`Initial navigation issue: ${e.message}`));

  // 4. VNC server on the display (optional password for privacy).
  const vncArgs = ['-display', display, '-forever', '-shared', '-rfbport', String(vncPort), '-quiet', '-noxdamage'];
  if (input.liveViewPassword) {
    const pwFile = '/tmp/.x11vncpass';
    await runOnce('x11vnc', ['-storepasswd', input.liveViewPassword, pwFile]);
    vncArgs.push('-rfbauth', pwFile);
  } else {
    vncArgs.push('-nopw');
  }
  startProc('x11vnc', vncArgs, 'x11vnc');
  await sleep(1500);

  // 5. noVNC web client via websockify on the container web port.
  startProc('websockify', ['--web=/usr/share/novnc', String(webPort), `localhost:${vncPort}`], 'websockify');
  await sleep(1500);

  const clientUrl = liveUrlBase
    ? `${liveUrlBase}/vnc.html?autoconnect=true&resize=remote`
    : "the run's Live View tab";

  log.info('==================================================================');
  log.info('  SAVE-SESSION MODE — interactive manual login');
  log.info('  1) Open the run\'s "Live View" tab in the Apify console, or:');
  log.info(`       ${clientUrl}`);
  log.info(
    input.liveViewPassword
      ? '  2) Enter your live-view password when noVNC prompts.'
      : '  2) (No live-view password set — the URL is unguessable but unauthenticated. Set liveViewPassword to lock it.)'
  );
  log.info('  3) Log into your SIXT corporate account by hand (2FA/CAPTCHA included).');
  log.info(`  4) Stay logged in. The session saves automatically after ~${minutes} min.`);
  log.info('  The actor never reads or stores your password.');
  log.info('==================================================================');

  // 6. Hold the window open, with a countdown in the log.
  const totalMs = minutes * 60_000;
  const step = 60_000;
  for (let elapsed = 0; elapsed < totalMs; elapsed += step) {
    await sleep(Math.min(step, totalMs - elapsed));
    const remaining = Math.ceil((totalMs - elapsed - step) / 60_000);
    if (remaining > 0) log.info(`  ~${remaining} minute(s) remaining to finish logging in...`);
  }

  // 7. Persist the session.
  const state = await context.storageState();
  const cookieCount = state.cookies?.length || 0;
  await Actor.setValue(SESSION_KEY, state);

  await browser.close().catch(() => {});

  if (cookieCount === 0) {
    log.warning('No cookies were captured. Did the login complete? You may need to re-run save-session.');
    return { saved: false, cookies: 0 };
  }

  log.info(`Success — saved ${SESSION_KEY} to the Key-Value Store (${cookieCount} cookies).`);
  return { saved: true, cookies: cookieCount };
}
