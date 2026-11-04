// Netlify Function: everything that isn't a static file in public/ —
// login, the /x/<site>/ proxy, and Referer-routed requests.
import { handle } from '../../lib/core.js';

export default (request) => handle(request);

export const config = {
  path: '/*',
  preferStatic: true, // public/index.html and public/__sbs/* are served by the CDN
};
