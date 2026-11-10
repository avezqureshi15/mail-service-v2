/**
 * Keeps the Render backend from spinning down.
 *
 * Render's free instance type sleeps after ~15 minutes without an inbound
 * HTTP request. This application is not request-driven - the sender paces
 * messages, the sequencer schedules follow-ups, and the inbox poller watches
 * for bounces and replies - so a sleeping instance silently stops doing all
 * three. This pings it often enough that it never idles out.
 *
 * WHY THIS LIVES ON NETLIFY rather than inside the backend: a timer in the
 * app can only run while the app is awake, so it can keep the service alive
 * but can never bring it back. Once it sleeps - after a deploy, a crash, or
 * a quiet spell - an internal ping is asleep too. The wake-up call has to
 * come from outside the thing being woken.
 *
 * It requests the site's own URL, which `netlify.toml` proxies through to
 * Render, so there is no backend URL to configure here and nothing to keep
 * in step when the Render URL changes.
 */
export default async () => {
  // Netlify injects URL for the production site. DEPLOY_URL covers branch
  // and preview deploys, where URL is not set.
  const site = process.env.URL ?? process.env.DEPLOY_URL;

  if (!site) {
    console.error('keep-alive: neither URL nor DEPLOY_URL is set - cannot determine the site to ping');
    return new Response('no site URL', { status: 500 });
  }

  // The cache-buster is not optional. Netlify can serve a proxied response
  // from its CDN, and a cached 200 would mean this function reports success
  // while Render never sees a request at all - the service would sleep and
  // the logs would still read "ok". A unique URL each run cannot be cached.
  const target = `${site}/api/healthz?keepalive=${Date.now()}`;
  const startedAt = Date.now();

  try {
    // Generous timeout on purpose: a cold start from sleep takes far longer
    // than a warm health check, and that slow response is precisely the case
    // this function exists to handle. Giving up at 5s would log a failure
    // every time it actually did its job.
    const response = await fetch(target, {
      signal: AbortSignal.timeout(60_000),
      headers: { 'user-agent': 'netlify-keep-alive', 'cache-control': 'no-cache' },
    });

    const ms = Date.now() - startedAt;

    if (!response.ok) {
      console.error(`keep-alive: ${target} returned ${response.status} after ${ms}ms`);
      return new Response(`backend returned ${response.status}`, { status: 502 });
    }

    // Worth noticing in the logs: a warm instance answers in well under a
    // second, so a slow reply means it had gone to sleep and this woke it.
    console.log(`keep-alive: ok in ${ms}ms${ms > 5000 ? ' (slow - the instance had spun down)' : ''}`);
    return new Response('ok');
  } catch (error) {
    console.error(`keep-alive: ${target} failed after ${Date.now() - startedAt}ms - ${error.message}`);
    return new Response(`ping failed: ${error.message}`, { status: 502 });
  }
};

// Every 10 minutes, comfortably inside Render's ~15 minute idle window so a
// single missed run cannot let the instance sleep.
export const config = {
  schedule: '*/10 * * * *',
};
