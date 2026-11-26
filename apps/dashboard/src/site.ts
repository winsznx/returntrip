/**
 * Public links. The repository and demo video come from the build environment, and every link to
 * them is hidden until they're set, so the site never points at a page that doesn't exist yet.
 */
export const SITE = {
  repoUrl: import.meta.env.VITE_RETURNTRIP_REPO_URL || null,
  demoUrl: import.meta.env.VITE_RETURNTRIP_DEMO_URL || null,
  anchorPrUrl: 'https://github.com/we-promise/sure/pull/4754',
  datasetUrl: 'https://data.cityofchicago.org/Administration-Finance/Payments/s4vu-giwb',
  dataTermsUrl: 'https://www.chicago.gov/city/en/narr/foia/data_disclaimer.html',
} as const;
