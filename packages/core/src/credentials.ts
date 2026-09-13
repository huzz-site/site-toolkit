export function readCloudflareToken(): string | undefined {
  return process.env.CLOUDFLARE_API_TOKEN ?? process.env.SITE_CLOUDFLARE_API_TOKEN;
}
