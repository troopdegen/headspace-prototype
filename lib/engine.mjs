/* ESM bridge to the shared, framework-free engine.js (UMD: works as a plain
   <script> global in the browser, and via require() in Node). Vercel's Node
   functions run under `"type": "module"`, so API code imports this file
   instead of engine.js directly. createRequire is Node's own supported way
   to pull in a CommonJS module from ESM; it is not a hack. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export default require('../engine.js');
