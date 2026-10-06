/// <reference types="vite/client" />

// swagger-ui-dist's index pulls in a Node-only path helper and the standalone
// preset; the docs page imports just the browser bundle (CommonJS export).
declare module 'swagger-ui-dist/swagger-ui-bundle.js' {
  import type { SwaggerUIBundle } from 'swagger-ui-dist';
  const bundle: SwaggerUIBundle;
  export default bundle;
}
