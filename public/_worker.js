export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await env.ASSETS.fetch(request);
    
    // If the asset exists (JS, CSS, images, etc.), return it as-is
    if (response.status !== 404) return response;
    
    // For 404s, serve index.html with 200 status (SPA routing)
    const indexResponse = await env.ASSETS.fetch(new Request(new URL('/', url.origin), request));
    return new Response(indexResponse.body, {
      status: 200,
      headers: indexResponse.headers,
    });
  }
};
