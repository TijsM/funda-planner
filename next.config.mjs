/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /* Static for now, so the GitHub Pages deploy keeps working. Delete this line
     the day the first API route lands — see docs/ARCHITECTURE.md. */
  output: 'export',
  images: { unoptimized: true },
};
export default nextConfig;
