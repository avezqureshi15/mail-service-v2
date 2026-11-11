/**
 * Why a message came back, and whether that says anything about the address.
 *
 * The distinction matters because the Mail Predictor learns from bounces. A
 * `5.1.1 user unknown` means the address is wrong and the format that
 * produced it should be demoted. A `5.7.1` spam block means the receiving
 * server did not like *us* - the address may be perfectly good, and treating
 * it as evidence would retire a working format on the strength of a
 * reputation problem.
 *
 * Hence the tri-state:
 *
 *   learnsAddress === true   the address is wrong; safe to demote a format
 *   learnsAddress === false  not about the address; must not touch a format
 *   learnsAddress === null   unclear; record it, but do not act on it
 *
 * `null` is not an oversight. A disabled or moved mailbox genuinely does not
 * tell you whether the address was ever right, and collapsing that into
 * either boolean loses information the scorer will want later.
 */

/** RFC 3463 enhanced status codes, most specific first. */
const DSN_RULES = [
  // Permanent, and about the recipient's local part.
  [/^5\.1\.1$/, 'user_unknown', 'hard', true],
  [/^5\.1\.3$/, 'bad_syntax', 'hard', true],
  [/^5\.1\.10$/, 'user_unknown', 'hard', true],

  // Permanent, but about the domain or the route rather than the mailbox.
  [/^5\.1\.2$/, 'domain_unreachable', 'hard', false],
  [/^5\.4\.\d+$/, 'domain_unreachable', 'hard', false],
  [/^5\.5\.\d+$/, 'protocol_error', 'hard', false],

  // Permanent, but about us: policy, reputation, authentication.
  [/^5\.7\.(1|0)$/, 'policy_block', 'hard', false],
  [/^5\.7\.(23|24|25|26)$/, 'auth_failure', 'hard', false],
  [/^5\.7\.\d+$/, 'policy_block', 'hard', false],

  // The mailbox exists in some form but cannot take mail right now.
  [/^5\.2\.2$/, 'mailbox_full', 'soft', false],
  [/^5\.2\.1$/, 'mailbox_unavailable', 'hard', null],
  [/^5\.1\.6$/, 'mailbox_unavailable', 'hard', null],

  // Anything else permanent.
  [/^5\.\d+\.\d+$/, 'permanent_other', 'hard', null],

  // Transient. Never evidence about an address.
  [/^4\.2\.2$/, 'mailbox_full', 'soft', false],
  [/^4\.7\.\d+$/, 'policy_block', 'soft', false],
  [/^4\.\d+\.\d+$/, 'transient', 'soft', null],
];

const AUTO_REPLY = /out of (the )?office|auto[\s-]?(reply|responder|matic reply)|on (annual |maternity |paternity )?leave|vacation (reply|message)|currently away|thank you for your (email|message).{0,40}(will respond|get back)/i;

const result = (type, reason, learnsAddress, code = '') =>
  ({ type, reason, learnsAddress, code });

/**
 * @param {{dsnStatus?: string, smtpCode?: string, text?: string}} input
 * @returns {{type: 'hard'|'soft'|'auto_reply'|'unknown', reason: string,
 *            learnsAddress: boolean|null, code: string}}
 */
export function classifyBounceReason({ dsnStatus = '', smtpCode = '', text = '' }) {
  const status = String(dsnStatus).trim();
  const code = String(smtpCode).match(/\b([45]\d{2})\b/)?.[1] ?? '';
  const body = String(text);

  // A real delivery report carries a machine-readable status. Check it
  // before any text heuristic: a bounce often quotes the original message,
  // so phrase-matching first would let the quoted body decide.
  for (const [pattern, reason, type, learnsAddress] of DSN_RULES) {
    if (pattern.test(status)) return result(type, reason, learnsAddress, status);
  }

  if (code) {
    // 550 is overwhelmingly "no such user" in practice, but it is also what
    // a content filter returns, so the code alone cannot settle intent.
    if (code.startsWith('5')) return result('hard', 'permanent_other', null, code);
    return result('soft', 'transient', null, code);
  }

  // No DSN and no code: this is probably not a bounce at all.
  if (AUTO_REPLY.test(body)) return result('auto_reply', 'auto_reply', false);

  if (/(user|mailbox|recipient|address)\s+(unknown|not found|does not exist|doesn't exist)/i.test(body)
    || /no such (user|mailbox|recipient)/i.test(body)
    || /invalid (recipient|mailbox|address)/i.test(body)
    || /550[\s-]*5\.1\.1/i.test(body)
    || /recipient address rejected/i.test(body)) {
    return result('hard', 'user_unknown', true);
  }

  if (/account (has been )?(disabled|deactivated|closed|terminated)/i.test(body)
    || /mailbox (is )?(disabled|inactive|no longer)/i.test(body)) {
    return result('hard', 'mailbox_unavailable', null);
  }

  if (/domain (not found|does not exist)|unrouteable|unroutable|host unknown/i.test(body)) {
    return result('hard', 'domain_unreachable', false);
  }

  if (/blocked|blacklist|blocklist|spam|policy reasons|reputation/i.test(body)) {
    return result('hard', 'policy_block', false);
  }

  if (/(mailbox|quota|storage).{0,20}(full|exceeded|limit)/i.test(body)
    || /over quota/i.test(body)) {
    return result('soft', 'mailbox_full', false);
  }

  if (/temporar(y|ily)|try again later|deferred|greylist/i.test(body)) {
    return result('soft', 'transient', null);
  }

  return result('unknown', 'unknown', null);
}

/** Only a wrong address may demote the format that produced it. */
export function demotesFormat(classification) {
  return classification?.learnsAddress === true;
}

export const REASON_LABELS = {
  user_unknown: 'No such mailbox',
  bad_syntax: 'Address rejected as malformed',
  mailbox_unavailable: 'Mailbox disabled or moved',
  mailbox_full: 'Mailbox full',
  domain_unreachable: 'Domain could not be reached',
  protocol_error: 'Mail server protocol error',
  policy_block: 'Blocked by the receiving server (reputation or content)',
  auth_failure: 'Rejected for failing authentication (SPF, DKIM or DMARC)',
  transient: 'Temporary failure',
  auto_reply: 'Automatic reply, not a bounce',
  permanent_other: 'Permanent failure, reason unclear',
  unknown: 'Could not be classified',
};
