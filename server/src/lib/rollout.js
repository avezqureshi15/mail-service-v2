/**
 * How much of a company to hand over at once.
 *
 * A format learned from a single seed is a claim, not a fact. Releasing
 * fifty addresses built on it means fifty bounces if the claim is wrong,
 * through a mailbox provider that is already the tightest constraint this
 * service has. So a company starts on probation: one person, sent, and the
 * rest unlock once something comes back.
 *
 * The state is **derived**, never stored. A stored state is a second copy
 * of the truth that has to be transitioned correctly from every code path,
 * and the first missed transition leaves a company wrongly locked or
 * wrongly open. Everything needed is already in `domain_patterns`.
 */

export const STATES = ['unknown', 'probing', 'validated', 'disputed'];

/**
 * @param {Array<{provenance: string, confirmed_count: number, rejected_count: number}>} rows
 *   the domain's pattern rows, as `patternsForDomains` returns them.
 */
export function rolloutStateFor(rows = []) {
  if (!rows || rows.length === 0) return 'unknown';

  // Delivery or a reply settles it, and outranks any failure: knowing the
  // format is right makes a bounce elsewhere a fact about that person.
  if (rows.some((r) => r.provenance === 'proven' || r.confirmed_count > 0)) {
    return 'validated';
  }

  // Something bounced in a way that blamed the address, and nothing has
  // succeeded yet. Keep probing, but say so.
  if (rows.some((r) => r.rejected_count > 0)) return 'disputed';

  return 'probing';
}

export const STATE_LABELS = {
  unknown: 'We have no format for this company yet.',
  probing: 'Format not confirmed by a delivery yet - send one and see.',
  validated: 'Format confirmed by delivery.',
  disputed: 'An address here bounced and nothing has landed yet.',
};

/**
 * Trims a company's results to what should be acted on now.
 *
 * Only the response is trimmed. Every candidate is still computed and
 * ranked, so unlocking later costs nothing and the reasoning stays
 * inspectable.
 *
 * @returns {{revealed: object[], held: object[], rollout: object}}
 */
export function gateResults({ results = [], state, probeBudget = 1, domain = '' }) {
  const budget = Math.max(1, Number(probeBudget) || 1);

  if (state === 'validated') {
    return {
      revealed: results,
      held: [],
      rollout: {
        state,
        domain,
        probe: false,
        probeBudget: budget,
        revealed: results.length,
        heldPeople: 0,
        heldAlternatives: 0,
        label: STATE_LABELS[state],
        nextAction: '',
      },
    };
  }

  const revealed = results.slice(0, budget);
  const held = results.slice(budget);

  // Alternatives are hidden too. Offering a second guess for the same
  // person invites sending both, which is the dictionary-attack pattern
  // receiving servers watch for - and it is precisely what probation is
  // meant to prevent.
  const heldAlternatives = revealed.reduce((n, r) => n + (r.alternatives?.length ?? 0), 0);
  const trimmed = revealed.map((r) => ({ ...r, alternatives: [] }));

  return {
    revealed: trimmed,
    held,
    rollout: {
      state,
      domain,
      probe: true,
      probeBudget: budget,
      revealed: trimmed.length,
      heldPeople: held.length,
      heldAlternatives,
      label: STATE_LABELS[state] ?? '',
      nextAction: held.length > 0 || heldAlternatives > 0
        ? `Send ${trimmed.length === 1 ? 'this one' : `these ${trimmed.length}`} and wait for the outcome. `
          + `${held.length} more here unlock once something lands or bounces.`
        : `Send ${trimmed.length === 1 ? 'this one' : 'these'} and wait for the outcome.`,
    },
  };
}

/**
 * Per-company gating for a bulk run.
 *
 * @param {object[]} results rows carrying a `domain`
 * @param {Map<string, string>} stateByDomain
 */
export function gateByDomain(results, stateByDomain, probeBudget = 1) {
  const byDomain = new Map();
  for (const result of results) {
    if (!byDomain.has(result.domain)) byDomain.set(result.domain, []);
    byDomain.get(result.domain).push(result);
  }

  const revealed = [];
  const rollouts = [];

  for (const [domain, rows] of byDomain) {
    const gated = gateResults({
      results: rows,
      state: stateByDomain.get(domain) ?? 'probing',
      probeBudget,
      domain,
    });
    revealed.push(...gated.revealed);
    if (gated.rollout.probe) rollouts.push(gated.rollout);
  }

  // Companies holding the most back first - that is where sending one
  // message unlocks the most work.
  rollouts.sort((a, b) => b.heldPeople - a.heldPeople);
  return { revealed, rollouts };
}
