/**
 * Minimal client for an OpenAI-compatible chat endpoint (DeepSeek by
 * default).
 *
 * Built on the runtime's own fetch rather than a vendor SDK: the surface we
 * use is one POST with a JSON body, and a dependency that wraps that is
 * weight without benefit.
 *
 * Two rules hold everywhere this is used:
 *
 *  - **It is never required.** No key configured means every call returns
 *    null and the caller carries on with its deterministic path. A model
 *    being down must never stop an operator predicting addresses.
 *  - **Its output is never trusted.** Every response is parsed and then
 *    validated against a schema by the caller. A model asked for JSON will
 *    occasionally return prose, a fenced block, or a plausible-looking
 *    object with the wrong shape.
 *
 * The key comes from the environment and is never logged, echoed in an
 * error, or sent anywhere but the configured endpoint.
 */

import { env } from '../config/env.js';

export function isEnabled() {
  return env.llmEnabled;
}

/**
 * Pulls the first JSON value out of a model response.
 *
 * Even with a JSON response format asked for, a model will sometimes wrap
 * the answer in a fenced block or add a sentence before it.
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost object or array in the text.
    const start = candidate.search(/[[{]/);
    if (start === -1) return null;
    const open = candidate[start];
    const close = open === '[' ? ']' : '}';
    const end = candidate.lastIndexOf(close);
    if (end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * One chat completion, returning parsed JSON or null.
 *
 * @param {{system: string, user: string, maxTokens?: number, temperature?: number}} options
 * @param {{fetchImpl?: Function}} [deps] - injection point for tests.
 * @returns {Promise<unknown|null>}
 */
export async function chatJson(
  { system, user, maxTokens = 4000, temperature = 0 },
  { fetchImpl = globalThis.fetch } = {},
) {
  if (!env.llmEnabled) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        // Deterministic: the same name should split the same way every run,
        // or a re-run quietly produces different addresses.
        temperature,
        max_tokens: maxTokens,
        // Only sent when configured, so a provider without the field is
        // unaffected. DeepSeek's default is 'high', which spends real time
        // deliberating over a task that needs none.
        ...(env.LLM_EFFORT ? { effort: env.LLM_EFFORT } : {}),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Deliberately does not include the body: an auth failure from some
      // gateways echoes the Authorization header back.
      console.error(`[llm] ${response.status} ${response.statusText}`);
      return null;
    }

    const payload = await response.json();
    return extractJson(payload?.choices?.[0]?.message?.content);
  } catch (error) {
    console.error(`[llm] request failed: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Splits work into the configured batch size. */
export function batched(items, size = env.LLM_BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
