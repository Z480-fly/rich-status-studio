/**
 * The origin this app is deployed at in production.
 *
 * Anything that must point at the live site needs this shared constant rather
 * than the page's own location: the same build is also served from Discord's
 * Activity proxy (`<client_id>.discordsays.com`), from preview hosts and from
 * localhost. On the server, `PUBLIC_SITE_URL` overrides it at runtime.
 */
export const PUBLIC_SITE_ORIGIN = "https://rich-status-studio.lovable.app";
