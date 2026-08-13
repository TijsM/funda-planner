/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /* Static for now, so the GitHub Pages deploy keeps working. Delete this line
     the day the first API route lands — see docs/ARCHITECTURE.md. */
  output: 'export',
  images: { unoptimized: true },
  /* Next 16 refuses dev-asset requests from origins it does not recognise, so
     a browser pointed at 127.0.0.1 gets 403s on every chunk while localhost
     works. The e2e run drives it headlessly, hence both. */
  allowedDevOrigins: ['localhost', '127.0.0.1'],
};
export default nextConfig;
