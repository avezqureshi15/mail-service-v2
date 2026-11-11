/**
 * Smoke test for the name model.
 *
 * Confirms three things at once that are otherwise only visible deep inside
 * a prediction run: the key works, LLM_MODEL names a model that exists, and
 * the prompt comes back in the shape the validator expects.
 *
 * Touches no database and sends no mail. One request, a dozen names.
 *
 *   node scripts/test-name-model.js
 *   node scripts/test-name-model.js "Some Name" "Another Name"
 */

import { env } from '../src/config/env.js';
import { isEnabled } from '../src/lib/llm.js';
import { enrichNames, needsModel } from '../src/lib/name-intelligence.js';
import { parseName } from '../src/lib/parse-name.js';
import { normaliseName } from '../src/lib/email-patterns.js';

// Each one is a case the rules get wrong or cannot settle alone.
const SAMPLES = [
  'Balla Praveen',           // South Indian order - given name second
  'Venkatesh Rao',           // long given name, usually shortened
  'Krishnamurthy Iyer',      // same, more so
  'Robert Smith',            // bob / rob
  'Sharma, Rajesh',          // reversed by comma
  'Dr. Priyamvada Kaushik',  // honorific
  'AJ Khan',                 // initials or a name?
  'Mike (Michael) Chen',     // nickname in brackets
  'Maria Jose Garcia Lopez', // four words - where does the surname start?
  'R. Karthik',              // leading initial, given name second
  'Abhishek Bachchan',       // abhi
  'Anna Smith',              // the easy case, as a control
];

async function main() {
  const names = process.argv.slice(2).filter(Boolean);
  const subjects = names.length > 0 ? names : SAMPLES;

  console.log(`endpoint : ${env.LLM_BASE_URL}`);
  console.log(`model    : ${env.LLM_MODEL}`);
  console.log(`key      : ${isEnabled() ? 'set' : 'NOT SET'}\n`);

  if (!isEnabled()) {
    console.log('LLM_API_KEY is not set, so the predictor runs on rules alone.');
    console.log('Add it to server/.env and run this again.');
    return;
  }

  // Mirrors the single-company route, which asks about every name: the
  // rules cannot tell that "Balla Praveen" needs a second opinion, and that
  // is precisely the case worth catching. Bulk uses the `needsModel` filter
  // instead, so the count is shown for comparison.
  const flagged = subjects.filter(needsModel);
  console.log(`${subjects.length} names, all sent (as the single-company page does).`);
  console.log(`A bulk upload would send only the ${flagged.length} the rules flag.\n`);

  const started = Date.now();
  const enrichment = await enrichNames(subjects);
  const ms = Date.now() - started;

  if (enrichment.size === 0) {
    console.log('The model returned nothing usable.\n');
    console.log('Most likely one of:');
    console.log('  - LLM_MODEL does not name a model your key can reach');
    console.log('  - the key is wrong or out of credit');
    console.log('  - the endpoint is not OpenAI-compatible');
    console.log('\nThe error line above (if any) came from the client.');
    process.exitCode = 1;
    return;
  }

  console.log(`answered ${enrichment.size}/${flagged.length} in ${ms}ms\n`);
  console.log('='.repeat(72));

  for (const name of subjects) {
    const rules = parseName(name);
    const model = enrichment.get(name);

    console.log(`\n  ${name}`);

    if (!rules.ok) console.log(`    rules : cannot split (${rules.reason})`);
    else console.log(`    rules : ${rules.first} / ${rules.middle || '-'} / ${rules.last}`);

    if (!model) {
      console.log('    model : no usable answer - rules stand');
      continue;
    }
    if (!needsModel(name)) console.log('    note  : a bulk run would not have asked about this one');

    const disagrees = rules.ok && normaliseName(rules.last) !== normaliseName(model.last);
    console.log(`    model : ${model.first} / ${model.middle || '-'} / ${model.last}${disagrees ? '   <-- different surname' : ''}`);
    if (model.shortForms.length > 0) {
      console.log(`    short : ${model.shortForms.join(', ')}`);
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  const swapped = [...enrichment.values()].filter((v) => v.swapped).length;
  const withShort = [...enrichment.values()].filter((v) => v.shortForms.length > 0).length;
  console.log(`\n  ${swapped} names where the model picked a different surname`);
  console.log(`  ${withShort} names with short forms worth trying`);
  console.log('\nBoth become extra candidates, ranked behind the main reading.');
}

main().catch((error) => {
  console.error('\nFailed:', error.message);
  process.exitCode = 1;
});
