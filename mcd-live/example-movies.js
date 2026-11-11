// Public example-movie catalogue for the static GitHub Pages demonstration.
// Adding a compatible movie to mcd-live/examples/ and pushing to main
// automatically makes it available through the public GitHub Contents API.
// A bundled manifest also supports local previews and temporary API failures.
const GITHUB_EXAMPLES_API =
  'https://api.github.com/repos/xisarr/cesareparise.github.io/contents/mcd-live/examples?ref=main';
const LOCAL_MANIFEST = new URL('./examples/movies.json', import.meta.url);
const KNOWN_EXAMPLES = Object.freeze(['av_synchrony_chart.mp4', 'Ventriloquist_Movie.mp4']);

export function isExampleMovieName(name) {
  return typeof name === 'string'
    && name.length > 0 && name.length < 200
    && !name.startsWith('.')
    && !name.includes('/') && !name.includes('\\')
    && !/[\x00-\x1f\x7f]/.test(name)
    && /\.(mp4|m4v|webm|mov)$/i.test(name);
}

export function exampleMovieLabel(name) {
  return name.replace(/\.(mp4|m4v|webm|mov)$/i, '')
    .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\bav\b/ig, 'AV');
}

export function exampleMovieURL(name) {
  if (!isExampleMovieName(name)) throw new Error('Invalid example-movie filename.');
  return new URL(`./examples/${encodeURIComponent(name)}`, import.meta.url);
}

function normaliseList(items) {
  return [...new Set(items.filter(isExampleMovieName))]
    .sort((a, b) => exampleMovieLabel(a).localeCompare(exampleMovieLabel(b), undefined, {sensitivity: 'base'}));
}

export async function listExampleMovies() {
  // GitHub Pages does not provide directory listings. Query the public repo
  // on the deployed site; its contents update when new movies are pushed.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!local) {
    try {
      const response = await fetch(GITHUB_EXAMPLES_API, {
        headers: {'Accept': 'application/vnd.github+json'}
      });
      if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error('Unexpected GitHub API response');
      return normaliseList(items.filter(item => item && item.type === 'file').map(item => item.name));
    } catch (error) {
      console.info('Example catalogue: using the bundled list', error);
    }
  }
  try {
    const response = await fetch(LOCAL_MANIFEST, {cache: 'no-store'});
    if (!response.ok) throw new Error(`Local manifest HTTP ${response.status}`);
    const items = await response.json();
    if (Array.isArray(items)) return normaliseList(items);
  } catch (error) {
    console.info('Example catalogue: using built-in defaults', error);
  }
  return normaliseList(KNOWN_EXAMPLES);
}
