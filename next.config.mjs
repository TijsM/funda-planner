/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /* Was `output: 'export'` for a GitHub Pages deploy that CI never actually ran.
     The first API routes have landed — the render provider key and the login
     password have to stay server-side — so the app now needs a Node host.
     See docs/ARCHITECTURE.md and docs/RENDER-IN-APP.md. */
  images: { unoptimized: true },
  /* Next 16 refuses dev-asset requests from origins it does not recognise, so
     a browser pointed at 127.0.0.1 gets 403s on every chunk while localhost
     works. The e2e run drives it headlessly, hence both. */
  allowedDevOrigins: ['localhost', '127.0.0.1'],
};
export default nextConfig;
