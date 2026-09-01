/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'resources.premierleague.com' }],
  },
};

export default nextConfig;
