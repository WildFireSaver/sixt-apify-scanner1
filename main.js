import { Actor, log } from 'apify';
import { applyDefaults } from './lib/session.js';
import { saveSession } from './save_session.js';
import { runScan } from './scan.js';

await Actor.init();

const input = applyDefaults((await Actor.getInput()) || {});

try {
  if (input.mode === 'save-session') {
    log.info('Mode: save-session');
    const result = await saveSession(input);
    await Actor.setValue('SAVE_SESSION_RESULT', result);
    if (!result.saved) {
      throw new Error('save-session finished but no session was captured.');
    }
    log.info('save-session succeeded.');
  } else {
    log.info('Mode: scan');
    await runScan(input);
  }
} finally {
  await Actor.exit();
}
