/**
 * Sending-provider presets.
 *
 * The service is provider-agnostic: everything below the transport works the
 * same whichever one is in use. What differs is the host pair, the SPF
 * include that must appear on the sending domain, the DKIM selector, and the
 * sending ceiling to stay under.
 *
 * `spfInclude` is what the DNS checker verifies. Getting it wrong - an
 * include for a different provider or a different region of the same
 * provider - produces a record that reads correctly and fails every message.
 */

export const PROVIDERS = {
  google: {
    id: 'google',
    label: 'Google Workspace / Gmail',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    spfInclude: '_spf.google.com',
    // Workspace publishes DKIM under a selector chosen in the admin console;
    // "google" is the default it offers.
    dkimSelector: 'google',
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    // Workspace caps external recipients per rolling 24h. The free gmail.com
    // tier is far lower. Exceeding it locks sending for ~24 hours.
    dailyLimit: 2000,
    // What campaigns may use. Deliberately well under the ceiling: the same
    // mailbox also sends ordinary human email, and that counts against the
    // same quota. Running campaigns at the limit means a normal day's replies
    // are what finally trips the suspension.
    recommendedDailyCap: 1200,
    dailyLimitNote:
      'Google Workspace allows roughly 2,000 messages per rolling 24 hours; a free '
      + 'gmail.com account is around 500. Exceeding it suspends sending for about a day.',
    // Gmail will not let you forge an arbitrary From. Anything other than the
    // authenticated mailbox or a verified "Send mail as" alias is rewritten,
    // which silently breaks both your branding and DKIM alignment.
    fromMustMatchUser: true,
    bulkPolicyNote:
      'Google states Gmail and Workspace are for person-to-person mail and directs bulk '
      + 'senders to a dedicated provider. Cold outreach at volume risks the account.',
  },

  zoho: {
    id: 'zoho',
    label: 'Zoho Mail',
    smtpHost: 'smtp.zoho.com',
    smtpPort: 465,
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    spfInclude: 'zoho.com',
    dkimSelector: 'zoho',
    appPasswordUrl: 'https://accounts.zoho.com/home#security/app_password',
    // No published figure, so this is a conservative working estimate of the
    // ceiling rather than a documented one.
    dailyLimit: 500,
    recommendedDailyCap: 300,
    dailyLimitNote:
      'Zoho publishes no fixed cap - an algorithm sets it from account usage and '
      + 'reputation, so it can tighten without warning.',
    fromMustMatchUser: false,
    bulkPolicyNote:
      'Zoho states Zoho Mail is for one-to-one business communication and directs bulk '
      + 'senders to Zoho Campaigns or ZeptoMail.',
    // Zoho runs regional data centres; the SPF include has to match the one
    // the account lives in.
    regions: {
      com: 'Global', in: 'India', eu: 'Europe', 'com.au': 'Australia', jp: 'Japan', uk: 'UK', sa: 'Saudi Arabia',
    },
    regionHosts: (region) => ({
      smtpHost: `smtp.zoho.${region}`,
      imapHost: `imap.zoho.${region}`,
      spfInclude: `zoho.${region}`,
    }),
  },

  other: {
    id: 'other',
    label: 'Other SMTP provider',
    smtpHost: '',
    smtpPort: 587,
    imapHost: '',
    imapPort: 993,
    spfInclude: null,
    dkimSelector: 'default',
    appPasswordUrl: null,
    dailyLimit: null,
    recommendedDailyCap: 400,
    dailyLimitNote: 'Set the daily cap to match whatever your provider allows.',
    fromMustMatchUser: false,
    bulkPolicyNote: null,
  },
};

/**
 * A warm-up ramp from a cold start up to `target` sends/day.
 *
 * Roughly geometric rather than linear: receivers react to the *rate of
 * change* in volume, so a domain that jumps from 20 to 400 looks compromised
 * even if 400 is a perfectly ordinary number for it later. Starts at 20 and
 * grows ~35% a day, which reaches a few hundred in about three weeks.
 */
export function buildWarmupSchedule(target, { start = 20, growth = 1.35 } = {}) {
  const schedule = [];
  let value = start;

  while (value < target && schedule.length < 60) {
    schedule.push(Math.round(value));
    value *= growth;
  }
  schedule.push(target);

  return schedule;
}

/**
 * Pacing defaults scaled to a provider's recommended cap, so changing
 * provider does not leave an hourly cap or send interval that silently
 * contradicts the daily figure.
 */
export function pacingDefaults(provider) {
  const dailyCap = provider.recommendedDailyCap ?? 400;

  // The working day the send window covers, used to spread the daily figure.
  const windowHours = 10;
  const hourlyCap = Math.ceil(dailyCap / windowHours);

  // Average gap needed to fit the daily cap inside the window, with ~20%
  // slack so jitter and retries do not push against the ceiling.
  const minIntervalSeconds = Math.max(5, Math.floor((windowHours * 3600) / (dailyCap * 1.2)));

  return {
    dailyCap,
    hourlyCap,
    minIntervalSeconds,
    // One receiving domain should never take more than a fraction of an
    // hour's volume, however large that hour is.
    perDomainHourlyCap: Math.max(10, Math.ceil(hourlyCap * 0.25)),
    warmupSchedule: buildWarmupSchedule(dailyCap),
  };
}

/** Best guess at the provider from a configured SMTP host. */
export function providerFromHost(host = '') {
  const value = String(host).toLowerCase();
  if (/(^|\.)gmail\.com$|(^|\.)google\.com$/.test(value)) return 'google';
  if (/(^|\.)zoho\./.test(value)) return 'zoho';
  return 'other';
}

/**
 * Resolves a provider preset, applying the regional variant where the
 * provider has them.
 *
 * @param {string} id      One of PROVIDERS.
 * @param {string} host    The configured SMTP host, used to detect the region.
 */
export function resolveProvider(id, host = '') {
  const base = PROVIDERS[id] ?? PROVIDERS.other;
  if (!base.regions) return base;

  const region = String(host).toLowerCase().match(/^smtp\.zoho\.(.+)$/)?.[1];
  if (!region || !(region in base.regions)) return base;

  return { ...base, region, ...base.regionHosts(region) };
}
