/* Public configuration only: no API token or other secret belongs here.
 * Local/preview pages and ?stats=off are excluded by usage-analytics.js.
 * Enabled on the existing approved GitHub Pages addresses after publishing.
 */
export const USAGE_CONFIG = Object.freeze({
  enabled: true,
  endpoint: 'https://mcd-usage.cesare-parise.workers.dev/collect',
  allowedOrigins: ['https://xisarr.github.io'],
  allowedPaths: ['/cesareparise.github.io/mcd-live/', '/mcd-live/'],
  pageViewsEnabled: true,
  webAnalyticsToken: '857e1ec1c01c4eb699d704bfae1cda20',
  respectPrivacySignals: true,
  engagedSeconds: 30,
});
