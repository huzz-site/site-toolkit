name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy:
    uses: huzz-site/site-toolkit/.github/workflows/deploy.yml@v1
    with:
      cloudflare-account-id: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
