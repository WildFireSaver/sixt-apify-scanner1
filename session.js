import { Actor } from 'apify';

const SESSION_KEY = 'SIXT_SESSION';

export function applyDefaults(input) {
  input.mode ||= 'scan';
  if (input.pickupCode && !input.pickupLocation) input.pickupLocation = input.pickupCode;
  if (input.dropoffCode && !input.dropoffLocation) input.dropoffLocation = input.dropoffCode;
  if (input.pickupTime && !input.pickupTimes) input.pickupTimes = [input.pickupTime];
  input.pickupLocation ||= 'LAX';
  input.dropoffLocation ||= 'LAX';
  input.preferredMakes ||= ['BMW', 'Mercedes', 'Range Rover', 'Audi'];
  input.vehicleClasses ||= ['Premium SUV', 'Luxury SUV', 'Executive SUV'];
  input.minDays ??= 5;
  input.maxDays ??= 27;
  input.pickupTimes ||= ['10:00'];
  input.dateWindowStart ||= '2026-07-01';
  input.dateWindowEnd ||= '2026-07-31';
  input.sixtBaseUrl ||= 'https://www.sixt.com/';
  input.dateStepDays ??= 7;
  input.dayStep ??= 1;
  input.testRunOnly ??= true;
  input.maxSearches ??= 50;
  input.minDelayMs ??= 8000;
  input.maxDelayMs ??= 20000;
  input.postBatchSize ??= 200;
  input.liveViewMinutes ??= 10;
  input.liveViewWidth ??= 1440;
  input.liveViewHeight ??= 900;
  return input;
}

/**
 * Load the SIXT session. Priority:
 *   1. input.loginSession (if provided)
 *   2. Key-Value Store key SIXT_SESSION (saved by mode "save-session")
 * Throws a clear error if neither exists.
 */
export async function loadSession(input) {
  let session = input.loginSession;
  if (!session) session = await Actor.getValue(SESSION_KEY);

  if (!session || !session.cookies || session.cookies.length === 0) {
    throw new Error('No SIXT session found. Run mode save-session first.');
  }
  return session;
}

export { SESSION_KEY };
